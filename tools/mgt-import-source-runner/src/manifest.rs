use serde::Serialize;

use crate::{
    MAX_CONTAINER_BYTES, MAX_ENTRY_COUNT, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS, MAX_PAGE_BYTES,
    MAX_PAGE_COUNT, MAX_TOTAL_BYTES,
};

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ImportKind {
    Pdf,
    Rar,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedPage {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) byte_length: u64,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportManifest {
    pub(crate) version: u8,
    pub(crate) kind: ImportKind,
    pub(crate) pages: Vec<ImportedPage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProgressRecord {
    pub(crate) version: u8,
    #[serde(rename = "type")]
    pub(crate) record_type: &'static str,
    pub(crate) current: usize,
    pub(crate) total: usize,
    pub(crate) unit: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Capabilities {
    version: u8,
    formats: [&'static str; 3],
    max_container_bytes: u64,
    max_entry_count: usize,
    max_page_count: usize,
    max_page_bytes: u64,
    max_total_bytes: u64,
    max_image_pixels: u64,
    max_image_dimension: u32,
}

impl Capabilities {
    pub(crate) fn current() -> Self {
        Self {
            version: 1,
            formats: ["pdf", "rar", "cbr"],
            max_container_bytes: MAX_CONTAINER_BYTES,
            max_entry_count: MAX_ENTRY_COUNT,
            max_page_count: MAX_PAGE_COUNT,
            max_page_bytes: MAX_PAGE_BYTES,
            max_total_bytes: MAX_TOTAL_BYTES,
            max_image_pixels: MAX_IMAGE_PIXELS,
            max_image_dimension: MAX_IMAGE_DIMENSION,
        }
    }
}
