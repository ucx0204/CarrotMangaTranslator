use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{Context, Result, bail};
use rars::{ArchiveMember, ArchiveReadOptions, ArchiveReader, ExtractedEntryMeta};

use crate::manifest::{ImportKind, ImportManifest, ImportedPage};
use crate::{MAX_ENTRY_COUNT, MAX_PAGE_BYTES, MAX_PAGE_COUNT, MAX_TOTAL_BYTES, manifest};

const MAX_COMPRESSION_RATIO: u64 = 100;
const RATIO_GRACE_BYTES: u64 = 1024 * 1024;

#[derive(Debug)]
struct PendingPage {
    name: String,
    extension: &'static str,
    temporary_path: PathBuf,
    expected_bytes: u64,
    written_bytes: u64,
    completed: bool,
}

#[derive(Debug)]
struct ExtractionState {
    pages: Vec<PendingPage>,
    selected_by_name: HashMap<Vec<u8>, VecDeque<usize>>,
    total_written: u64,
    completed_count: usize,
}

pub(crate) fn import_rar(input: &Path, output: &Path) -> Result<ImportManifest> {
    let archive = ArchiveReader::read_path(input).context("Unable to parse RAR/CBR archive")?;
    let members: Vec<_> = archive.members().collect();
    let state = Rc::new(RefCell::new(preflight_members(&members, output)?));
    if state.borrow().pages.is_empty() {
        bail!("RAR/CBR archive contains no supported image pages");
    }
    crate::emit_progress(0, state.borrow().pages.len());

    let callback_state = Rc::clone(&state);
    let options = ArchiveReadOptions::new().with_rar50_buffered_decode_limit(MAX_PAGE_BYTES);
    archive
        .extract_to_with_options(options, move |meta| open_entry(meta, &callback_state))
        .context("Unable to extract RAR/CBR archive")?;

    let state = Rc::try_unwrap(state)
        .map_err(|_| anyhow::anyhow!("RAR extraction state is still shared"))?
        .into_inner();
    finalize_pages(state, output)
}

fn preflight_members(members: &[ArchiveMember], output: &Path) -> Result<ExtractionState> {
    if members.len() > MAX_ENTRY_COUNT {
        bail!("RAR/CBR archive has more than {MAX_ENTRY_COUNT} entries");
    }
    let mut pages = Vec::new();
    let mut selected_by_name: HashMap<Vec<u8>, VecDeque<usize>> = HashMap::new();
    let mut total_unpacked = 0_u64;

    for member in members {
        let display_name = member.meta.name_lossy();
        let Some(extension) = supported_extension(&display_name) else {
            continue;
        };
        if member.meta.is_directory || is_metadata_path(&display_name) {
            continue;
        }
        if member.meta.is_encrypted {
            bail!("Encrypted RAR/CBR image entries are not supported");
        }
        if member.meta.is_split_before || member.meta.is_split_after {
            bail!("Multi-volume RAR/CBR archives are not supported");
        }
        if member.meta.unpacked_size > MAX_PAGE_BYTES {
            bail!("RAR/CBR image entry exceeds the page byte limit");
        }
        let ratio_limit = member
            .meta
            .packed_size
            .saturating_mul(MAX_COMPRESSION_RATIO)
            .max(RATIO_GRACE_BYTES);
        if member.meta.unpacked_size > ratio_limit {
            bail!("RAR/CBR image entry exceeds the compression ratio limit");
        }
        total_unpacked = total_unpacked
            .checked_add(member.meta.unpacked_size)
            .context("RAR/CBR unpacked size overflow")?;
        if total_unpacked > MAX_TOTAL_BYTES {
            bail!("RAR/CBR archive exceeds the total unpacked byte limit");
        }
        if pages.len() >= MAX_PAGE_COUNT {
            bail!("RAR/CBR archive has more than {MAX_PAGE_COUNT} image pages");
        }
        if selected_by_name.contains_key(member.meta.name_bytes()) {
            bail!("RAR/CBR archive contains duplicate image entry names");
        }

        let index = pages.len();
        let temporary_path = output.join(format!("raw-{index:06}.{extension}"));
        pages.push(PendingPage {
            name: normalized_entry_name(&display_name),
            extension,
            temporary_path,
            expected_bytes: member.meta.unpacked_size,
            written_bytes: 0,
            completed: false,
        });
        selected_by_name
            .entry(member.meta.name.clone())
            .or_default()
            .push_back(index);
    }

    Ok(ExtractionState {
        pages,
        selected_by_name,
        total_written: 0,
        completed_count: 0,
    })
}

fn open_entry(
    meta: &ExtractedEntryMeta,
    state: &Rc<RefCell<ExtractionState>>,
) -> rars::Result<Box<dyn Write>> {
    let index = state
        .borrow_mut()
        .selected_by_name
        .get_mut(meta.name_bytes())
        .and_then(VecDeque::pop_front);
    let Some(index) = index else {
        return Ok(Box::new(io::sink()));
    };
    let path = state.borrow().pages[index].temporary_path.clone();
    let file = OpenOptions::new().write(true).create_new(true).open(path)?;
    Ok(Box::new(BudgetedFileWriter {
        file,
        index,
        state: Rc::clone(state),
    }))
}

struct BudgetedFileWriter {
    file: File,
    index: usize,
    state: Rc<RefCell<ExtractionState>>,
}

impl Write for BudgetedFileWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        {
            let state = self.state.borrow();
            let page = &state.pages[self.index];
            let incoming = bytes.len() as u64;
            if page.written_bytes.saturating_add(incoming) > MAX_PAGE_BYTES
                || state.total_written.saturating_add(incoming) > MAX_TOTAL_BYTES
            {
                return Err(io::Error::other("RAR/CBR extraction byte limit exceeded"));
            }
        }
        let written = self.file.write(bytes)?;
        let mut state = self.state.borrow_mut();
        state.pages[self.index].written_bytes += written as u64;
        state.total_written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl Drop for BudgetedFileWriter {
    fn drop(&mut self) {
        let (completed, total) = {
            let mut state = self.state.borrow_mut();
            if !state.pages[self.index].completed {
                state.pages[self.index].completed = true;
                state.completed_count += 1;
            }
            (state.completed_count, state.pages.len())
        };
        crate::emit_progress(completed, total);
    }
}

fn finalize_pages(mut state: ExtractionState, output: &Path) -> Result<ImportManifest> {
    for page in &state.pages {
        if !page.completed || page.written_bytes != page.expected_bytes {
            bail!("RAR/CBR image entry was not extracted completely");
        }
        let metadata = fs::metadata(&page.temporary_path)?;
        if !metadata.is_file() || metadata.len() != page.written_bytes {
            bail!("RAR/CBR extracted page failed file validation");
        }
    }
    state
        .pages
        .sort_by(|left, right| natural_compare(&left.name, &right.name));

    let mut imported = Vec::with_capacity(state.pages.len());
    for (index, page) in state.pages.into_iter().enumerate() {
        let relative_path = format!("page-{:06}.{}", index + 1, page.extension);
        let final_path = output.join(&relative_path);
        fs::rename(&page.temporary_path, &final_path)
            .with_context(|| format!("Unable to finalize {}", final_path.display()))?;
        imported.push(ImportedPage {
            name: page.name,
            relative_path,
            byte_length: page.written_bytes,
            width: None,
            height: None,
        });
    }
    Ok(manifest(ImportKind::Rar, imported))
}

fn supported_extension(name: &str) -> Option<&'static str> {
    let file_name = name.rsplit(['/', '\\']).next()?;
    let extension = file_name.rsplit_once('.')?.1;
    if extension.eq_ignore_ascii_case("png") {
        Some("png")
    } else if extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg") {
        Some("jpg")
    } else if extension.eq_ignore_ascii_case("webp") {
        Some("webp")
    } else {
        None
    }
}

fn is_metadata_path(name: &str) -> bool {
    let normalized = normalized_entry_name(name);
    normalized.split('/').any(|part| {
        part.eq_ignore_ascii_case("__MACOSX")
            || part.eq_ignore_ascii_case(".DS_Store")
            || part.eq_ignore_ascii_case("Thumbs.db")
            || part.eq_ignore_ascii_case("desktop.ini")
            || part.starts_with("._")
    })
}

fn normalized_entry_name(name: &str) -> String {
    name.replace('\\', "/")
}

fn natural_compare(left: &str, right: &str) -> Ordering {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    let mut left_chars = left.chars().peekable();
    let mut right_chars = right.chars().peekable();
    loop {
        match (left_chars.peek(), right_chars.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a), Some(b)) if a.is_ascii_digit() && b.is_ascii_digit() => {
                let left_number = take_digits(&mut left_chars);
                let right_number = take_digits(&mut right_chars);
                let left_trimmed = left_number.trim_start_matches('0');
                let right_trimmed = right_number.trim_start_matches('0');
                let left_significant = if left_trimmed.is_empty() {
                    "0"
                } else {
                    left_trimmed
                };
                let right_significant = if right_trimmed.is_empty() {
                    "0"
                } else {
                    right_trimmed
                };
                let order = left_significant
                    .len()
                    .cmp(&right_significant.len())
                    .then_with(|| left_significant.cmp(right_significant))
                    .then_with(|| left_number.len().cmp(&right_number.len()));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(_), Some(_)) => {
                let order = left_chars.next().cmp(&right_chars.next());
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

fn take_digits<I>(chars: &mut std::iter::Peekable<I>) -> String
where
    I: Iterator<Item = char>,
{
    let mut digits = String::new();
    while chars.peek().is_some_and(char::is_ascii_digit) {
        digits.push(chars.next().expect("peeked digit must exist"));
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;
    use rars::rar15_40::{StoredEntry, WriterOptions, write_stored_archive};
    use tempfile::tempdir;

    #[test]
    fn extracts_supported_pages_safely_and_sorts_naturally() {
        let temp = tempdir().unwrap();
        let input = temp.path().join("sample.cbr");
        let output = temp.path().join("output");
        fs::create_dir(&output).unwrap();
        let page_two = b"\x89PNG\r\n\x1a\npage-two";
        let page_ten = b"\xff\xd8\xffpage-ten";
        let metadata = b"ignored";
        let entries = [
            stored_entry(b"chapter/page10.jpg", page_ten),
            stored_entry(b"__MACOSX/._page1.png", metadata),
            stored_entry(b"chapter/page2.png", page_two),
            stored_entry(b"notes.txt", metadata),
        ];
        let archive = write_stored_archive(&entries, WriterOptions::default()).unwrap();
        fs::write(&input, archive).unwrap();

        let result = import_rar(&input, &output).unwrap();

        assert_eq!(result.pages.len(), 2);
        assert_eq!(result.pages[0].name, "chapter/page2.png");
        assert_eq!(result.pages[1].name, "chapter/page10.jpg");
        assert_eq!(fs::read(output.join("page-000001.png")).unwrap(), page_two);
        assert_eq!(fs::read(output.join("page-000002.jpg")).unwrap(), page_ten);
    }

    #[test]
    fn metadata_and_extension_checks_are_case_insensitive() {
        assert_eq!(supported_extension("folder/PAGE.JPEG"), Some("jpg"));
        assert!(is_metadata_path("folder/Thumbs.db/page.png"));
        assert!(is_metadata_path("__MACOSX/page.png"));
        assert!(!is_metadata_path("chapter/page.png"));
    }

    fn stored_entry<'a>(name: &'a [u8], data: &'a [u8]) -> StoredEntry<'a> {
        StoredEntry {
            name,
            data,
            file_time: 0,
            file_attr: 0,
            host_os: 0,
            password: None,
            file_comment: None,
        }
    }
}
