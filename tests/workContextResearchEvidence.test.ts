/* eslint-disable max-lines -- evidence trust-boundary regressions share builders and cross-case normalization fixtures */
import { describe, expect, it } from "vitest";
import {
  buildTranslatedCriticalEvidenceOperations,
  enrichResearchResultFromEvidence,
  extractCorroboratedEvidenceTitles,
  extractResultTitleCandidates,
  extractTrustedEvidenceTitles,
  selectCriticalEvidenceTranslationCandidates,
} from "../src/main/workContextResearchEvidence";
import type { WorkContextResearchPromptInput } from "../src/main/workContextResearchPrompt";

const timestamp = "2026-08-28T00:00:00.000Z";

describe("work-context research evidence normalization", () => {
  it("extracts a work title across HTML breaks and incomplete edition labels", () => {
    const title = "星海の案内人は古都で眠る";
    for (const raw of [
      `星雲コミックス<br> ${title}【分冊版`,
      `星雲コミックス ${title}【分冊版`,
      `${title} 【連載版`,
    ]) {
      expect(extractResultTitleCandidates(raw)).toContain(title);
    }
  });

  it("strips navigation breadcrumbs and Markdown markers from a work title", () => {
    const title =
      "折り紙職人ミモザの日記帳～病弱だった私は異世界に転生して健康な体を手に入れたので、前世でできなかった恩返しの旅に出る～";
    expect(
      extractResultTitleCandidates(`TOP > 連載シリーズ > ${title}`),
    ).toContain(title);
    expect(extractResultTitleCandidates(`**${title}`)).toContain(title);
    expect(extractResultTitleCandidates(`Shelve ${title}`)).toContain(title);
  });

  it("collapses duplicated titles separated by serialization and provider metadata", () => {
    const title = "トモダチがほしかったので悪魔を復活させましたわ！";
    const decorated = `${title} 【連載版】８－① (BC)${title} 【連載版】８－①`;

    expect(extractResultTitleCandidates(decorated)).toContain(title);
    expect(extractResultTitleCandidates(decorated)).not.toContain(decorated);
    expect(
      extractResultTitleCandidates(`BC ${title} 【連載版】７後半`),
    ).toContain(title);
    expect(extractResultTitleCandidates(`${title} 1 （）`)).toContain(title);
    expect(extractResultTitleCandidates(`↓${title}`)).toContain(title);
  });

  it("strips award and contest labels that precede a corroborated work title", () => {
    const title = "月明かりの錬金術師は辺境で暮らす";

    for (const decorated of [
      `電子コミック大賞20 ${title}`,
      `第8回ファンタジー小説グランプリ受賞作品 ${title}`,
      `異世界作品コンテスト2026 ノミネート作品 ${title}`,
      `(179ページ目)公式-${title}`,
    ]) {
      expect(extractResultTitleCandidates(decorated)).toContain(title);
      expect(extractResultTitleCandidates(decorated)).not.toContain(decorated);
    }
  });

  it("strips publication-status labels and volume marks from a serialized title", () => {
    const title = "月明かりの錬金術師は辺境で暮らす～錬金術で村を救います～";
    const decorated = `コミック発売中 ${title.replace(/～$/u, "①～")}`;

    expect(extractResultTitleCandidates(decorated)).toContain(title);
    expect(extractResultTitleCandidates(decorated)).not.toContain(decorated);
  });

  it("drops a decorated work title proposed as a glossary entry", () => {
    const input = makeInput();
    input.workTitle = "Tomodachi ga Hoshikatta no de Akuma wo Fukkatsu";
    const title = "トモダチがほしかったので悪魔を復活させましたわ！";
    const decorated = `↓${title}`;
    const searches = [
      {
        query: `"${input.workTitle}" original title`,
        credits: 1,
        results: [
          {
            title: decorated,
            url: "https://catalog-a.example/title/friends",
            content: title,
            score: 0.9,
          },
          {
            title: `${title} | 作品ページ`,
            url: "https://catalog-b.example/work/friends",
            content: title,
            score: 0.85,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: decorated,
            target: "친구가 갖고 싶어서 악마를 부활시켰습니다!",
            category: "other",
            aliases: [],
            sources: [{ title: decorated, url: searches[0].results[0].url }],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations).toEqual([]);
  });

  it("keeps character names and named titles while dropping copied synopsis noise", () => {
    const input = makeInput();
    input.workTitle =
      "울며 사과해도 교회에는 돌아가지 않겠습니다! 추방된 전 성녀 후보입니다";
    input.selection.text = "";
    input.guide.glossary = [];
    input.guide.characters = [];
    const nativeTitle =
      "泣いて謝られても教会には戻りません！～追放された元聖女候補ですが、同じく追放された『剣神』様と意気投合して第二の人生を始めます～";
    const synopsis =
      "次期聖女となることが約束され、王子の婚約者として暮らしていたセルビア。追放されたセルビアは、「剣神」と呼ばれる最強の剣士ハルクと意気投合。冒険者パーティを結成し、チート級の力で進む爽快ファンタジー。";
    const results = ["publisher.example", "reader.example"].map(
      (host, index) => ({
        title: `${nativeTitle} | 作品ページ`,
        url: `https://${host}/work/saint-${index}`,
        content: synopsis,
        score: 0.95 - index * 0.05,
      }),
    );
    const searches = [
      {
        query: `"${nativeTitle}" 登場人物 キャラクター`,
        credits: 1,
        results,
      },
    ];
    const sources = results.map(({ title, url }) => ({ title, url }));
    const character = (sourceName: string, targetName: string) => ({
      entity: "character",
      action: "add",
      sourceNames: [sourceName],
      targetName,
      displayName: targetName,
      aliases: [],
      sources,
    });
    const glossary = (source: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source,
      target,
      category: "term",
      aliases: [],
      sources,
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("セルビア", "셀비아"),
          character("ハルク", "할크"),
          glossary("剣神", "검신"),
          glossary("冒険者パーティ", "모험가 파티"),
          glossary("チート級", "치트급"),
          glossary("爽快ファンタジー", "상쾌한 판타지"),
          glossary(nativeTitle, input.workTitle),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["セルビア"],
        }),
        expect.objectContaining({
          entity: "character",
          sourceNames: ["ハルク"],
        }),
        expect.objectContaining({ entity: "glossary", source: "剣神" }),
      ]),
    );
    const proposedValues = result.operations.flatMap((operation) => [
      typeof operation.source === "string" ? operation.source : "",
      ...(Array.isArray(operation.sourceNames) ? operation.sourceNames : []),
    ]);
    expect(proposedValues.join("\n")).not.toMatch(
      /冒険者パーティ|チート級|爽快ファンタジー|泣いて謝られても/u,
    );
  });

  it("recovers a title only when independent hosts corroborate it", () => {
    const title = "汎用的な日本語作品タイトル";
    const searches = [
      {
        query: "creator pair",
        credits: 1,
        results: [
          {
            title: `${title} / 作者A 作者B`,
            url: "https://publisher.example/comic/123",
            content: "作品紹介",
            score: 0.61,
          },
          {
            title: `${title} | 公式配信`,
            url: "https://reader.example/work/456",
            content: "作品紹介",
            score: 0.58,
          },
          {
            title: "作者Aのプロフィール",
            url: "https://social.example/author-a",
            content: "プロフィール",
            score: 0.95,
          },
        ],
      },
    ];

    expect(extractCorroboratedEvidenceTitles(searches)).toContain(title);
    expect(
      extractCorroboratedEvidenceTitles([
        {
          ...searches[0],
          results: searches[0].results.slice(0, 1),
        },
      ]),
    ).toEqual([]);
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "truncated title",
          credits: 1,
          results: [
            {
              title: `${title.slice(0, 10)} ... | Site A`,
              url: "https://a.example/work/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title.slice(0, 10)} ... | Site B`,
              url: "https://b.example/work/2",
              content: "作品紹介",
              score: 0.9,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("corroborates a native title exposed in result content instead of the page title", () => {
    const title =
      "ただの村人の僕が、三百年前の暴君皇子に転生してしまいました ～前世の知識で暗殺フラグを回避して、穏やかに生き残ります！～";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "roman title official",
          credits: 1,
          results: [
            {
              title: "Romanized database entry",
              url: "https://catalog-a.example/manga/1",
              content: `Native\n${title}`,
              score: 0.9,
            },
            {
              title: "Another romanized entry",
              url: "https://catalog-b.example/title/2",
              content: `Japanese script\n${title}`,
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("strips a creator prefix wrapped around a quoted work title", () => {
    const title =
      "28歳OL、悪役王子を始めました～不自由な異世界を改革します！～";
    const searches = [
      {
        query: "distinctive characters and creator",
        credits: 1,
        results: [
          {
            title: "新刊コミックニュース",
            url: "https://news.example/articles/28-ol",
            content: `六格レンチ「${title}」1巻が発売された。`,
            score: 0.9,
          },
          {
            title: `${title} | 書店`,
            url: "https://store.example/books/28-ol",
            content: "作品紹介",
            score: 0.85,
          },
        ],
      },
    ];

    expect(extractCorroboratedEvidenceTitles(searches)).toContain(title);
    expect(
      extractCorroboratedEvidenceTitles(searches).join("\n"),
    ).not.toContain("六格レンチ「");
  });

  it("canonicalizes store decorations and rejects a promotional synopsis as a title", () => {
    const title =
      "28歳OL、悪役王子を始めました～不自由な異世界を改革します！～";
    const synopsis =
      "なんとか汚名を返上すべく、世のため人のため、必死に奔走する織羽。最低の嫌われ者に転生してしまったシゴデキOLの、新しい人生が始まる!? 異世界【革命】ファンタジー、開幕!!";
    const searches = [
      {
        query: "romanized title recovery",
        credits: 1,
        results: [
          {
            title: `28歳OL、悪役王子を始めました（1） 〜不自由な異世界を改革します！〜 | 書店A`,
            url: "https://store-a.example/book/28-ol",
            content: `# ${title} ${title}\n# ${synopsis}`,
            score: 0.9,
          },
          {
            title: `【最新刊】${title} - 書店B`,
            url: "https://store-b.example/books/28-ol",
            content: `${title}\n${synopsis}`,
            score: 0.85,
          },
        ],
      },
    ];

    const recovered = extractCorroboratedEvidenceTitles(searches);
    expect(recovered).toContain(title);
    expect(recovered.join("\n")).not.toContain("（1）");
    expect(recovered.join("\n")).not.toContain("最新刊");
    expect(recovered.join("\n")).not.toContain("なんとか汚名");

    const input = makeInput();
    input.workTitle = "28-Sai OL, Akuyaku Oujo wo Hajimemashita";
    input.selection.text =
      'B1: source="OLの天川織羽が持ち主、オリバーに転生した。" | target=""';
    expect(
      selectCriticalEvidenceTranslationCandidates([], searches, input),
    ).not.toContain(title);
  });

  it("rejects a model title contaminated by search-result UI annotations", () => {
    const input = makeInput();
    input.workTitle =
      "Koushaku Reijou no Rouraku Mission ~Maou to no Seiryaku Kekkon";
    const contaminated =
      "Koushaku Reijou no Rouraku Mission ... Japanese script icon. 公爵令嬢の籠絡ミッション～";
    const source = {
      title: contaminated,
      url: "https://catalog.example/title/mission",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: contaminated,
            target: "공작 영애의 농락 미션",
            category: "other",
            aliases: [],
            sources: [source],
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" original title`,
          credits: 1,
          results: [
            {
              ...source,
              content: "作品紹介",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations).toEqual([]);
  });

  it("removes a trailing volume and publisher decoration from a recovered title", () => {
    const title = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "native title",
          credits: 1,
          results: [
            {
              title: `${title}1 (一二三書房)`,
              url: "https://publisher-a.example/book/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title} - ニコニコ漫画`,
              url: "https://publisher-b.example/work/1",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "imprint title",
          credits: 1,
          results: [
            {
              title: `${title}(1) (Kラノベブックス)`,
              url: "https://catalog-a.example/books/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title}（１）（コミックス）`,
              url: "https://catalog-b.example/title/2",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("prefers the work title inside a generic page-title and strips a creator suffix", () => {
    const title = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    const input = makeInput();
    input.workTitle =
      "Isekai ni Houchi Game Riron wo Mochikondara Sekai Saikyou ni Nareru Setsu";
    input.selection.text = 'B1: source="放置ゲーシステム" | target=""';
    const searches = [
      {
        query: `"${input.workTitle}" 原題 日本語 公式`,
        credits: 1,
        results: [
          {
            title: `放置ゲー理論開始 - ${title}（杯 雪乃） - 小説投稿サイト`,
            url: "https://novel-a.example/works/1",
            content: `${title}。放置ゲーシステムを異世界に持ち込む。`,
            score: 0.9,
          },
          {
            title: `${title}（杯 雪乃） - 作品ページ`,
            url: "https://novel-b.example/title/2",
            content: `${title}。放置ゲーシステム。`,
            score: 0.85,
          },
        ],
      },
    ];

    expect(extractTrustedEvidenceTitles(searches, input)).toContain(title);
    expect(
      selectCriticalEvidenceTranslationCandidates([], searches, input),
    ).toEqual(["放置ゲーシステム"]);
  });

  it("recovers explicitly named term families even when local OCR is empty", () => {
    const input = makeInput();
    input.workTitle = "新作の正式題名";
    input.selection.text = "";
    input.guide.glossary = [];
    input.guide.characters = [];
    const source = {
      title: "新作の正式題名 | 公式設定",
      url: "https://publisher.example/work/new",
    };
    const searches = [
      {
        query: '"新作の正式題名" 設定 用語 世界観 能力 アイテム',
        credits: 1,
        results: [
          {
            ...source,
            content:
              "固有スキル「星鍵」。武器名：黎明杖。種族名：月狼族。職業名：鍵師。階級名：白金級。システム名：魂刻印。",
            score: 0.99,
          },
        ],
      },
    ];

    expect(
      selectCriticalEvidenceTranslationCandidates([], searches, input),
    ).toEqual(
      expect.arrayContaining([
        "星鍵",
        "黎明杖",
        "月狼族",
        "鍵師",
        "白金級",
        "魂刻印",
      ]),
    );

    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          ["星鍵", "별의 열쇠"],
          ["黎明杖", "여명 지팡이"],
          ["月狼族", "월랑족"],
          ["鍵師", "열쇠사"],
          ["白金級", "백금급"],
          ["魂刻印", "영혼 각인"],
        ].map(([original, translated]) => ({
          entity: "glossary",
          action: "add",
          source: original,
          target: translated,
          category: "term",
          aliases: [],
          sources: [source],
        })),
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations.map((operation) => operation.source)).toEqual(
      expect.arrayContaining([
        "星鍵",
        "黎明杖",
        "月狼族",
        "鍵師",
        "白金級",
        "魂刻印",
      ]),
    );
  });

  it("recovers a quoted publication title from a decorated single-host operation", () => {
    const title = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    const decorated = `杯 雪乃 『${title}』一巻発売中!!`;
    const input = makeInput();
    input.workTitle =
      "Isekai ni Houchi Game Riron wo Mochikondara Sekai Saikyou ni Nareru Setsu";
    input.selection.text = 'B1: source="放置ゲーシステム" | target=""';
    const source = {
      title: decorated,
      url: "https://novel.example/works/idle-game",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 原題 日本語 公式`,
        credits: 1,
        results: [
          {
            ...source,
            content: `${title}。放置ゲーシステムを確立する。`,
            score: 0.9,
          },
        ],
      },
    ];
    const operation = {
      entity: "glossary",
      action: "add",
      source: decorated,
      target:
        "이세계에 방치 게임 이론을 가져왔더니 세계 최강이 될 수 있다는 설",
      category: "other",
      aliases: [],
      sources: [source],
    };

    expect(
      selectCriticalEvidenceTranslationCandidates([operation], searches, input),
    ).not.toContain(title);
    const result = enrichResearchResultFromEvidence(
      { operations: [operation], warnings: [] },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };
    expect(result.operations).toEqual([]);
  });

  it("removes a trailing electronic-edition badge and review-page decoration", () => {
    const title =
      "クズレス・オブリージュ 18禁ゲー世界のクズ悪役に転生してしまった俺は、原作知識の力でどうしてもモブ人生をつかみ取りたい";
    const searches = [
      {
        query: "native title",
        credits: 1,
        results: [
          {
            title: `${title}【電子特別版】のレビュー`,
            url: "https://store-a.example/book/1",
            content: "作品紹介",
            score: 0.9,
          },
          {
            title: `${title.replace("オブリージュ ", "オブリージュ６ ")}【電子限定特典付き】 （角川スニーカー文庫） アバタロー , kodamazon`,
            url: "https://store-b.example/book/1",
            content: "作品紹介",
            score: 0.85,
          },
        ],
      },
    ];
    expect(extractCorroboratedEvidenceTitles(searches)).toContain(title);
    expect(extractTrustedEvidenceTitles(searches, makeInput())).toContain(
      title,
    );
    expect(
      extractTrustedEvidenceTitles(searches, makeInput()).join("\n"),
    ).not.toMatch(/電子|レビュー/u);
  });

  it("removes Japanese review and spoiler suffixes from recovered titles", () => {
    const title = "最弱貴族に転生したので悪役たちを集めてみた";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "review title",
          credits: 1,
          results: [
            {
              title: `${title}の考察・ネタバレ・感想`,
              url: "https://review-a.example/work/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title}のネタバレ・感想`,
              url: "https://review-b.example/title/2",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("removes bundled-volume and ebook edition labels from recovered titles", () => {
    const title = "最弱貴族に転生したので悪役たちを集めてみた";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "ebook title",
          credits: 1,
          results: [
            {
              title: `${title} (全5巻) Kindle版`,
              url: "https://store-a.example/books/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title}（全5巻）電子書籍版`,
              url: "https://store-b.example/title/2",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "numbered title",
          credits: 1,
          results: [
            {
              title: `${title}（５）`,
              url: "https://reader-a.example/books/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title} (5)`,
              url: "https://reader-b.example/title/2",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("removes a known creator suffix without stripping arbitrary title parentheses", () => {
    const title = "最弱貴族に転生したので悪役たちを集めてみた";
    const input = makeInput();
    input.workTitle =
      "Saijaku Kizoku ni Tensei Shita node Akuyaku Tachi wo Atsumete Mita";
    input.selection.text =
      'B1: source="原作: 空野進 / 作画: sorani" | target=""\n' +
      'B2: source="最弱貴族アデル" | target=""';
    const searches = [
      {
        query: `"${input.workTitle}" 原題 公式`,
        credits: 1,
        results: [
          {
            title: `${title}（空野進）`,
            url: "https://publisher.example/books/1",
            content: "最弱貴族アデルの物語。",
            score: 0.9,
          },
        ],
      },
    ];

    expect(extractTrustedEvidenceTitles(searches, input)).toContain(title);
    expect(extractTrustedEvidenceTitles(searches, input)).not.toContain(
      `${title}（空野進）`,
    );
  });

  it("removes multilingual store volume suffixes from recovered titles", () => {
    const title = "最弱貴族に転生したので悪役たちを集めてみた";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "international store title",
          credits: 1,
          results: [
            {
              title: `${title}(5), 5. cilt`,
              url: "https://store-tr.example/books/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title} (5), Vol. 5`,
              url: "https://store-en.example/title/2",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("prefers a complete native title over its short series name", () => {
    const input = makeInput();
    input.workTitle = "KUZULESSE OBLIGE: 18-KIN GAME SEKAI NO KUZU AKUYAKU";
    input.selection.text =
      'B1: source="クズ悪役として転生し、モブ人生を目指す。" | target=""';
    const shortTitle = "クズレス・オブリージュ";
    const fullTitle =
      "クズレス・オブリージュ 18禁ゲー世界のクズ悪役に転生してしまった俺は、原作知識の力でどうしてもモブ人生をつかみ取りたい";
    const searches = [
      {
        query: '"KUZULESSE OBLIGE" 原題 日本語 公式',
        credits: 1,
        results: [
          {
            title: `${fullTitle} | 出版社公式`,
            url: "https://publisher.example/work/1",
            content: `${shortTitle}。クズ悪役としてモブ人生を目指す。`,
            score: 0.9,
          },
          {
            title: `${fullTitle} | 公式配信`,
            url: "https://reader.example/work/1",
            content: `${shortTitle}。クズ悪役としてモブ人生を目指す。`,
            score: 0.85,
          },
          {
            title: shortTitle,
            url: "https://catalog.example/work/1",
            content: `${fullTitle}。`,
            score: 0.95,
          },
        ],
      },
    ];

    expect(
      selectCriticalEvidenceTranslationCandidates([], searches, input),
    ).not.toContain(fullTitle);
  });

  it("prefers the dedicated complete title translation over an incomplete synthesis title", () => {
    const input = makeInput();
    input.workTitle = "KUZULESSE OBLIGE: 18-KIN GAME SEKAI";
    input.selection.text =
      'B1: source="クズ悪役として転生し、モブ人生を目指す。" | target=""';
    const title =
      "クズレス・オブリージュ 18禁ゲー世界のクズ悪役に転生してしまった俺は、原作知識の力でどうしてもモブ人生をつかみ取りたい";
    const sources = [
      {
        title: `${title} | 出版社公式`,
        url: "https://publisher.example/work/1",
      },
      {
        title: `${title} | 公式配信`,
        url: "https://reader.example/work/1",
      },
    ];
    const searches = [
      {
        query: '"KUZULESSE OBLIGE" 原題 日本語 公式',
        credits: 1,
        results: sources.map((source, index) => ({
          ...source,
          content: `${title}。クズ悪役としてモブ人生を目指す。`,
          score: 0.9 - index * 0.05,
        })),
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: title.replace(" ", "～") + "～",
            target:
              "18금 게임 세계의 쓰레기 악역으로 전생한 나는 모브 인생을 원한다",
            category: "other",
            aliases: [],
            sources,
          },
          {
            entity: "glossary",
            action: "add",
            source: title,
            target:
              "쿠즈레스 오블리주: 18금 게임 세계의 쓰레기 악역으로 전생한 나는 원작 지식으로 모브 인생을 거머쥐고 싶다",
            category: "other",
            aliases: [],
            sources,
            criticalTitleTranslation: true,
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("rejects creator-credit fragments as recovered titles", () => {
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "native title",
          credits: 1,
          results: [
            {
              title: "+ イラスト：kodamazon",
              url: "https://publisher.example/work/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: "+ イラスト：kodamazon",
              url: "https://reader.example/work/1",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("removes a trailing web-edition reader label from a recovered title", () => {
    const title = "スライムマスターちゃんのVRMMO";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "native title",
          credits: 1,
          results: [
            {
              title: `${title} - WEB読み`,
              url: "https://publisher.example/ebook/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title} - WEB連載`,
              url: "https://reader.example/work/1",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("removes a trailing product volume number from a recovered title", () => {
    const title = "スライムマスターちゃんのVRMMO";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "native title",
          credits: 1,
          results: [
            {
              title: `${title}1`,
              url: "https://store.example/book/1",
              content: "作品紹介",
              score: 0.9,
            },
            {
              title: `${title} 第1巻`,
              url: "https://publisher.example/work/1",
              content: "作品紹介",
              score: 0.85,
            },
          ],
        },
      ]),
    ).toContain(title);
  });

  it("normalizes decorated titles and rejects publication navigation as characters", () => {
    const input = makeInput();
    input.workTitle =
      "Tada no Murabito no Boku ga Sanbyakunen Mae no Boukun Ouji";
    input.selection.text =
      'B1: source="皇子ルドルフが未来を変える。" | target=""';
    const title =
      "ただの村人の僕が、三百年前の暴君皇子に転生してしまいました ～前世の知識で暗殺フラグを回避して、穏やかに生き残ります！～";
    const searches = [
      {
        query: '"Tada no Murabito no Boku" 登場人物',
        credits: 1,
        results: [
          {
            title: "Romanized database entry",
            url: "https://catalog-a.example/manga/1",
            content: `【11/25書籍第１巻発売！】${title}（サンボン）\n主人公ルドルフは未来を変える。\n登場人物\nコミックライド\nコミックライド`,
            score: 0.9,
          },
          {
            title: "Another romanized entry",
            url: "https://catalog-b.example/title/2",
            content: `コミックグロウルの${title}`,
            score: 0.85,
          },
          {
            title: "Store search result",
            url: "https://catalog-c.example/book/3",
            content: `3. ${title.replaceAll("～", "~")}2 (MFブックス)`,
            score: 0.8,
          },
        ],
      },
    ];
    const rawSource = {
      title: "Romanized database entry",
      url: "https://catalog-a.example/manga/1",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: `「【11/25書籍第１巻発売！】${title}（サンボン）`,
            target:
              "그저 마을 사람이었던 내가 폭군 황자로 전생했습니다 / 타스케(만화) 추천 무료 만화",
            category: "term",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ルドルフ"],
            targetName: "루돌프",
            displayName: "루돌프",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "glossary",
            action: "add",
            source: "三百年前",
            target: "300년 전",
            category: "term",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "glossary",
            action: "add",
            source: "村人",
            target: "마을 사람",
            category: "term",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "glossary",
            action: "add",
            source: "臨死体験",
            target: "임종 체험",
            category: "term",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["コミックライド"],
            targetName: "코믹 라이드",
            displayName: "코믹 라이드",
            aliases: [],
            sources: [rawSource],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["マガジン"],
            targetName: "매거진",
            displayName: "매거진",
            aliases: [],
            sources: [rawSource],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ entity: "glossary", source: title }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ sourceNames: ["ルドルフ"] }),
    );
    expect(JSON.stringify(result.operations)).not.toMatch(
      /コミックライド|マガジン/u,
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "三百年前" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "村人" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "臨死体験" }),
    );
  });

  it("trusts one direct roman-title recovery result only when local evidence also matches", () => {
    const input = makeInput();
    input.workTitle =
      "Tada no Murabito no Boku ga Sanbyakunen Mae no Boukun Ouji";
    input.selection.text =
      'B1: source="皇子ルドルフが未来を変える。" | target=""';
    const title = "ただの村人の僕が、三百年前の暴君皇子に転生してしまいました";
    const search = {
      query: '"Tada no Murabito no Boku" 原題 日本語 公式',
      credits: 1,
      results: [
        {
          title: `${title} | 出版社公式`,
          url: "https://publisher.example/products/123",
          content: "皇子ルドルフが暗殺の未来を変える物語。",
          score: 0.8,
        },
      ],
    };

    expect(extractTrustedEvidenceTitles([search], input)).toContain(title);
    expect(
      extractTrustedEvidenceTitles(
        [
          {
            ...search,
            results: [
              {
                ...search.results[0],
                content: "別作品の紹介。",
              },
            ],
          },
        ],
        input,
      ),
    ).toEqual([]);
  });

  it("locks the translated work title and preserves official readings and spellings", () => {
    const input = makeInput();
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            entryId: null,
            source: "バグスキル【開錠】で最強最速ダンジョン攻略",
            target: "버그 스킬 【해금】로 최강 최속 던전 공략",
            aliases: ["버그 스킬 해금", "バグスキル"],
          },
          {
            entity: "glossary",
            action: "add",
            entryId: null,
            source: "開錠",
            target: "해제",
            aliases: [],
          },
          {
            entity: "character",
            action: "add",
            entryId: null,
            sourceNames: ["・ラビィ"],
            aliases: [],
            sources: [],
          },
        ],
        warnings: [],
      },
      [
        {
          query: "official",
          credits: 1,
          results: [
            {
              title: "作品公式ページ",
              url: "https://example.test/official",
              content:
                "バグスキル【開錠】で最強最速ダンジョン攻略。開錠（アンロック）。登場人物ラヴィ。",
              score: 0.99,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({
        source: "バグスキル【開錠】で最強最速ダンジョン攻略",
      }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ aliases: ["アンロック"] }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["ラヴィ"],
        aliases: ["ラビィ"],
      }),
    );
  });

  it("expands short character names and joins a locally compacted reading term", () => {
    const input = makeInput();
    input.workTitle = "作品名";
    input.selection.text =
      'B1: source="イングリス" | ko="잉글리스"\n' +
      'B2: source="ハイラルメナス" | ko="하이랄 메너스"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            entryId: null,
            sourceNames: ["イングリス"],
            displayName: "잉글리스 유크스",
            targetName: "잉글리스 유크스",
            aliases: [],
            sources: [],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"作品名" 登場人物',
          credits: 1,
          results: [
            {
              title: "CHARACTER | 作品名",
              url: "https://anime.example/chara/",
              content: "イングリス・ユークス。天恵武姫（ハイラル・メナス）。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(
      result.operations.find((operation) => operation.entity === "character"),
    ).toMatchObject({
      sourceNames: ["イングリス・ユークス"],
      aliases: ["イングリス"],
      sources: [{ url: "https://anime.example/chara/" }],
    });
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "glossary",
        source: "天恵武姫",
        target: "하이랄 메너스",
        aliases: ["ハイラル・メナス"],
        sources: expect.arrayContaining([
          expect.objectContaining({ url: "https://anime.example/chara/" }),
        ]),
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ハイラル・メナス"],
      }),
    );
  });

  it("does not add a work title when the model omits it", () => {
    const input = makeInput();
    const result = enrichResearchResultFromEvidence(
      { operations: [], warnings: [] },
      [
        {
          query: "official",
          credits: 1,
          results: [
            {
              title: "作品公式ページ",
              url: "https://example.test/official",
              content:
                "バグスキル【開錠】で最強最速ダンジョン攻略の公式作品ページです。",
              score: 0.99,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("fills locally translated critical terms when a small model omits them", () => {
    const input = makeInput();
    input.selection.text +=
      '\nB2: source="開錠" | ko="해제"\nB3: source="五大迷宮" | ko="5대 미궁"';
    const result = enrichResearchResultFromEvidence(
      { operations: [], warnings: [] },
      [
        {
          query: "official critical terms",
          credits: 1,
          results: [
            {
              title: "作品公式ページ",
              url: "https://example.test/official",
              content:
                "バグスキル【開錠】で最強最速ダンジョン攻略。開錠（アンロック）で五大迷宮を攻略する。",
              score: 0.99,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "glossary",
          source: "開錠",
          target: "해제",
          aliases: ["アンロック"],
        }),
        expect.objectContaining({
          entity: "glossary",
          source: "五大迷宮",
          target: "5대 미궁",
          confidence: "high",
        }),
      ]),
    );
  });

  it("drops an official-source title even when local OCR cannot recover it", () => {
    const input = makeInput();
    input.selection.text =
      'B1: source="パグスキルジョプ攻略" | ko="버그 스킬 던전 공략"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            entryId: null,
            source: "バグスキル【開錠】で最強最速ダンジョン攻略",
            target: "잘못된 임시 제목",
            aliases: [],
          },
        ],
        warnings: [],
      },
      [
        {
          query: "official title",
          credits: 1,
          results: [
            {
              title: "バグスキル【開錠】で最強最速ダンジョン攻略 - カドコミ",
              url: "https://comic-walker.com/detail/KC_008745_S",
              content: "公式作品ページ",
              score: 0.99,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops an OCR-spaced title instead of turning it into a glossary entry", () => {
    const input = makeInput();
    input.workTitle =
      "악역 영애의 아버지로 환생했으므로, 아내와 딸을 사랑으로 보살피겠습니다";
    input.selection.text =
      'B1: source="悪役令嬢の 父親に転生 妻と娘を溺愛 します" | ko="악역 영애의 아버지로 환생해 아내와 딸을 지극히 사랑합니다"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            entryId: null,
            source: "悪役令嬢の父親に転生妻と娘を溺愛します",
            target: "임시 제목",
            aliases: [],
            sources: [],
          },
        ],
        warnings: [],
      },
      [
        {
          query: "official title",
          credits: 1,
          results: [
            {
              title:
                "悪役令嬢の父親に転生したので、妻と娘を溺愛します | 出版社作品ページ",
              url: "https://publisher.example/products/123",
              content: "カリス・フォールと家族の物語。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops a work title with publisher chrome", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text =
      'B1: source="転生悪女の黒歴史" | target="전생 악녀의 흑역사"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "転生悪女の黒歴史｜LaLa [月刊ララ]【白泉社】](",
            target: "전생 악녀의 흑역사",
            category: "other",
            aliases: [],
            sources: [
              {
                title: "転生悪女の黒歴史｜LaLa [月刊ララ]【白泉社】](",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"転生悪女の黒歴史" 公式',
          credits: 1,
          results: [
            {
              title: "転生悪女の黒歴史｜LaLa [月刊ララ]【白泉社】](",
              url: "https://publisher.example/work/1",
              content: "転生悪女の黒歴史の公式作品ページ。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("does not turn a creator-name fragment into a character", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text = [
      'B1: source="原作: 冬夏アキハル" | target=""',
      'B2: source="佐藤コノハには黒歴史がある。" | target=""',
    ].join("\n");
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["アキハル"],
            targetName: "아키하루",
            displayName: "아키하루",
            aliases: [],
            sources: [
              {
                title: "転生悪女の黒歴史 公式",
                url: "https://publisher.example/character/iana",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"転生悪女の黒歴史" 登場人物',
          credits: 1,
          results: [
            {
              title: "転生悪女の黒歴史 公式",
              url: "https://publisher.example/character/iana",
              content: "イアナ・マグノリア。原作: 冬夏アキハル。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("does not turn a genre label into a character", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    input.selection.text = 'B1: source="主人公の物語" | target=""';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ロマンス"],
            targetName: "로맨스",
            displayName: "로맨스",
            aliases: [],
            sources: [
              {
                title: "作品キャラクター",
                url: "https://publisher.example/character/",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"汎用作品名" 登場人物',
          credits: 1,
          results: [
            {
              title: "作品キャラクター",
              url: "https://publisher.example/character/",
              content: "ジャンル: ロマンス。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("prioritizes a locally grammatical mixed-script name and quoted term", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text =
      'B1: source="佐藤コノハには「黒歴史」がある。" | target=""';
    const searches = [
      {
        query: '"転生悪女の黒歴史" 公式',
        credits: 1,
        results: [
          {
            title: "転生悪女の黒歴史 | 公式作品ページ",
            url: "https://publisher.example/work/1",
            content: "佐藤コノハには『黒歴史』がある。",
            score: 0.95,
          },
        ],
      },
    ];
    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );

    expect(candidates.slice(0, 2)).toEqual(["佐藤コノハ", "黒歴史"]);
    expect(
      buildTranslatedCriticalEvidenceOperations(
        [
          { source: "佐藤コノハ", target: "사토 코노하" },
          { source: "黒歴史", target: "흑역사" },
        ],
        searches,
        input,
        candidates,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["佐藤コノハ"],
          targetName: "사토 코노하",
        }),
        expect.objectContaining({
          entity: "glossary",
          source: "黒歴史",
          target: "흑역사",
        }),
      ]),
    );
  });

  it("recovers a role-bound hero name and a katakana-kanji work term", () => {
    const input = makeInput();
    input.workTitle = "死神騎士は運命の婚約者を離さない";
    input.selection.text =
      'B1: source="キズモノ令嬢になったエメリーンは、英雄・ランスロットとの婚約を命じられた。" | target=""';
    const searches = [
      {
        query: '"死神騎士は運命の婚約者を離さない" 登場人物',
        credits: 1,
        results: [
          {
            title: "死神騎士は運命の婚約者を離さない | 公式",
            url: "https://publisher.example/work/1",
            content: "キズモノ令嬢エメリーンと英雄・ランスロットの婚約を描く。",
            score: 0.95,
          },
        ],
      },
    ];
    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );

    expect(candidates).toEqual(
      expect.arrayContaining(["ランスロット", "キズモノ令嬢"]),
    );
    expect(
      buildTranslatedCriticalEvidenceOperations(
        [
          { source: "ランスロット", target: "란슬롯" },
          { source: "キズモノ令嬢", target: "흠집 난 영애" },
        ],
        searches,
        input,
        candidates,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["ランスロット"],
          targetName: "란슬롯",
        }),
        expect.objectContaining({
          entity: "glossary",
          source: "キズモノ令嬢",
          target: "흠집 난 영애",
        }),
      ]),
    );
  });

  it("does not confuse a katakana work title with a character and recovers a role-bound protagonist", () => {
    const input = makeInput();
    input.workTitle = "KUZULESSE OBLIGE: 18-KIN GAME SEKAI NO KUZU AKUYAKU";
    input.selection.text =
      'B1: source="Alternative Name: クズレス・オブリージュ" | target=""';
    const fullTitle =
      "クズレス・オブリージュ～18禁ゲー世界のクズ悪役に転生してしまった俺は、原作知識の力でどうしてもモブ人生をつかみ取りたい～";
    const searches = [
      {
        query: `"${input.workTitle}" 登場人物`,
        credits: 1,
        results: [
          {
            title: `${fullTitle} | 出版社公式`,
            url: "https://publisher.example/series/kuzulesse",
            content:
              "アバタロー(原作)。史上最悪のクズ悪役と名高い嫌われキャラ、ウルトスだった。",
            score: 0.95,
          },
          {
            title: `${fullTitle} | 公式配信`,
            url: "https://reader.example/detail/kuzulesse",
            content: "主人公ウルトスはモブ人生を望んでいる。",
            score: 0.9,
          },
        ],
      },
    ];
    const sources = searches[0]?.results.map(({ title, url }) => ({
      title,
      url,
    }));
    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );
    expect(candidates).toContain("ウルトス");
    expect(
      candidates.filter((candidate) => candidate.includes("クズレス")),
    ).toHaveLength(0);

    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: fullTitle,
            target:
              "쿠즈레스 오블리주: 18금 게임 세계의 쓰레기 악역으로 전생한 나는 모브 인생을 얻고 싶다",
            category: "other",
            aliases: [],
            sources,
          },
          {
            entity: "glossary",
            action: "add",
            source: "クズレス・オブリージュ",
            target: "쿠즈레스 오블리주",
            category: "other",
            aliases: [],
            sources,
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["クズレス・オブリージュ"],
            targetName: "쿠즈레스 오블리주",
            displayName: "쿠즈레스 오블리주",
            aliases: [],
            sources,
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ウルトス"],
            targetName: "울토스",
            displayName: "울토스",
            aliases: [],
            sources,
          },
          {
            entity: "glossary",
            action: "add",
            source: "アバタロー",
            target: "아바타로",
            category: "other",
            aliases: [],
            sources: [
              {
                title: `${fullTitle} | 出版社公式`,
                url: "https://publisher.example/series/kuzulesse",
              },
            ],
          },
          {
            entity: "glossary",
            action: "add",
            source: "史上最悪のクズ悪役",
            target: "사상 최악의 쓰레기 악역",
            category: "term",
            aliases: [],
            sources,
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as {
      operations: Array<{
        entity?: string;
        source?: string;
        sourceNames?: string[];
      }>;
    };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ウルトス"],
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["クズレス・オブリージュ"],
      }),
    );
    expect(
      result.operations.filter(
        (operation) =>
          operation.entity === "glossary" &&
          operation.source?.includes("クズレス"),
      ),
    ).toHaveLength(0);
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "アバタロー" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "史上最悪のクズ悪役" }),
    );
  });

  it("builds character operations for role-bound kanji and katakana local names", () => {
    const input = makeInput();
    input.workTitle = "28-Sai OL, Akuyaku Oujo wo Hajimemashita";
    input.selection.text =
      'B1: source="OLの天川織羽は異世界に転生した。身体の元の持ち主、オリバーは悪役王子だった。" | target=""';
    const title = "28歳OL、悪役王子を始めました";
    input.workTitle = title;
    const searches = [
      {
        query: `"${input.workTitle}" "天川織羽"`,
        credits: 1,
        results: [
          {
            title: `${title} | 公式作品ページ`,
            url: "https://publisher.example/work/28-ol",
            content:
              "OLの天川織羽が転生した身体の元の持ち主、オリバーは悪役王子だった。",
            score: 0.95,
          },
        ],
      },
    ];
    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );
    expect(candidates).toEqual(
      expect.arrayContaining(["天川織羽", "オリバー"]),
    );
    const operations = buildTranslatedCriticalEvidenceOperations(
      [
        { source: "天川織羽", target: "아마카와 오리하" },
        { source: "オリバー", target: "올리버" },
      ],
      searches,
      input,
      candidates,
    );
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["天川織羽"],
        }),
        expect.objectContaining({
          entity: "character",
          sourceNames: ["オリバー"],
        }),
      ]),
    );
  });

  it("merges a role-prefixed katakana label into the underlying character", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    input.selection.text = 'B1: source="メイド・アネット" | target=""';
    const searches = [
      {
        query: '"汎用作品名" 登場人物',
        credits: 1,
        results: [
          {
            title: "汎用作品名 公式",
            url: "https://publisher.example/work/1",
            content: "メイド・アネットは箒を武器に戦う。",
            score: 0.95,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["アネット"],
            targetName: "아네트",
            displayName: "아네트",
            aliases: [],
            sources: [
              {
                title: "汎用作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["メイド・アネット"],
            targetName: "메이드 아넷",
            displayName: "메이드 아넷",
            aliases: [],
            sources: [
              {
                title: "汎用作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    const characters = result.operations.filter(
      (operation) => operation.entity === "character",
    );
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({
      sourceNames: ["アネット"],
      targetName: "아네트",
      aliases: ["メイド・アネット"],
    });
  });

  it("keeps a named monster but drops generic VRMMO introduction labels", () => {
    const input = makeInput();
    input.workTitle = "スライムマスターちゃんのVRMMO";
    input.selection.text =
      'B1: source="高校2年生の主人公は、最弱モンスター・スライムをパートナーにして、ライムちゃんと自分のペースで新感覚VRMMOを遊ぶ。" | target=""';
    const source = {
      title: `${input.workTitle} | 公式配信`,
      url: "https://reader.example/detail/slime-master",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 登場人物`,
        credits: 1,
        results: [
          {
            ...source,
            content:
              "高校2年生の主人公は、最弱モンスター・スライムをパートナーにして、ライムちゃんと自分のペースで新感覚VRMMOを遊ぶ。",
            score: 0.95,
          },
        ],
      },
    ];
    const glossary = (term: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source: term,
      target,
      category: "term",
      aliases: [],
      sources: [source],
    });
    const character = (
      name: string,
      target: string,
      action: "add" | "update" = "add",
    ) => ({
      entity: "character",
      action,
      sourceNames: [name],
      targetName: target,
      displayName: target,
      aliases: [],
      sources: [source],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("ライム", "라임"),
          character("スライム", "라임"),
          character("モンスター・スライム", "몬스터 슬라임"),
          character("ペース", "에이스"),
          character("クター", "닥터"),
          glossary("スライム", "슬라임"),
          glossary("最弱モンスター", "최약 몬스터"),
          glossary("パートナー", "파트너"),
          glossary("新感覚VRMMO", "신감각 VRMMO"),
          glossary("ハードモード", "하드 모드"),
          glossary("異世界", "이세계"),
          glossary("革命", "혁명"),
          glossary("学園", "학원"),
          glossary("ゼロ", "제로"),
          glossary("『ゼロ』", "'제로'"),
          glossary("ポジティブ主人公", "포지티브 주인공"),
          glossary("スタート軸", "스타트 축"),
          glossary("デバフ", "디버프"),
          glossary("死亡フラグ", "사망 플래그"),
          glossary("聖女", "성녀"),
          glossary("ゲーム知識", "게임 지식"),
          glossary("滅びた町", "멸망한 마을"),
          glossary("空間", "공간"),
          glossary("魔力", "마력"),
          glossary("魔法学院", "마법 학원"),
          glossary("帝国", "제국"),
          glossary("高校2年生", "고교 2학년"),
          glossary("2年生", "2학년"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as {
      operations: Array<{
        entity?: string;
        source?: string;
        sourceNames?: string[];
      }>;
    };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ライム"],
      }),
    );
    expect(
      result.operations.filter((operation) => operation.entity === "character"),
    ).toHaveLength(1);
  });

  it("drops generic family, fantasy, numeric, and sentence fragments while keeping setting terms", () => {
    const input = makeInput();
    input.workTitle = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    input.selection.text =
      'B1: source="放置ゲーシステム 五大魔境 魔石 お袋 三大欲求 闇狼はモッフモフ 悪役キャラ コングランプリ受賞作品 § スメラギ家" | target=""';
    const source = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/idle-game",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 設定 用語`,
        credits: 1,
        results: [
          {
            ...source,
            content:
              "放置ゲーシステムと五大魔境。魔石、お袋、三大欲求。闇狼はモッフモフ。悪役キャラ。コングランプリ受賞作品。§ スメラギ家。",
            score: 0.9,
          },
        ],
      },
    ];
    const glossary = (term: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source: term,
      target,
      category: "term",
      aliases: [],
      sources: [source],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          glossary("放置ゲーシステム", "방치 게임 시스템"),
          glossary("五大魔境", "오대마경"),
          glossary("魔石", "마석"),
          glossary("お袋", "어머니"),
          glossary("三大欲求", "삼대 욕구"),
          glossary("闇狼はモッフモフ", "어둠 늑대는 복슬복슬"),
          glossary("悪役キャラ", "악역 캐릭터"),
          glossary("コングランプリ受賞作品", "콩쿠르 그랑프리 수상작"),
          glossary("§ スメラギ家", "스메라기 가문"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };
    const sources = result.operations.map(({ source }) => source);

    expect(sources).toEqual(
      expect.arrayContaining(["放置ゲーシステム", "五大魔境"]),
    );
    expect(sources).not.toEqual(
      expect.arrayContaining([
        "魔石",
        "お袋",
        "三大欲求",
        "闇狼はモッフモフ",
        "悪役キャラ",
        "コングランプリ受賞作品",
        "§ スメラギ家",
      ]),
    );
  });

  it("drops role descriptions and common group nouns from character proposals", () => {
    const input = makeInput();
    input.workTitle = "折り紙職人ミモザの日記帳";
    input.selection.text =
      'B1: source="主人公のミモザは勇者の青年とパーティーに出会う。" | target=""';
    const source = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/origami",
    };
    const character = (name: string, targetName: string) => ({
      entity: "character",
      action: "add",
      sourceNames: [name],
      targetName,
      displayName: targetName,
      aliases: [],
      sources: [source],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("ミモザ", "미모자"),
          character("勇者の青年", "용사인 청년"),
          character("パーティー", "파티"),
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: [
            {
              ...source,
              content: "主人公のミモザは勇者の青年とパーティーに出会う。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<{ sourceNames?: string[] }> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({ sourceNames: ["ミモザ"] }),
    );
    expect(result.operations).toHaveLength(1);
  });

  it("drops a title phrase misclassified as a character while retaining a named protagonist", () => {
    const input = makeInput();
    input.workTitle = "TENSEI RENKIN SHOUJO NO SLOW LIFE";
    const originalTitle = "転生錬金少女のスローライフ";
    input.selection.text = `B1: source="${originalTitle}。主人公メリアが錬金術を使う。" | target=""`;
    const sources = [
      {
        title: `${originalTitle} 1 夜想庭園 [新文芸] - 出版社`,
        url: "https://publisher.example/work/alchemy-life",
      },
      {
        title: `${originalTitle}（Web版）（夜想庭園） - 小説投稿サイト`,
        url: "https://reader.example/title/alchemy-life",
      },
    ];
    const character = (name: string, targetName: string) => ({
      entity: "character",
      action: "add",
      sourceNames: [name],
      targetName,
      displayName: targetName,
      aliases: [],
      sources,
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("スローライフ", "슬로 라이프"),
          character("メリア", "메리아"),
          {
            entity: "glossary",
            action: "add",
            source: "スローライフ",
            target: "슬로 라이프",
            category: "term",
            aliases: [],
            sources,
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: sources.map((source, index) => ({
            ...source,
            content: `${originalTitle}。主人公メリアが錬金術を使う。`,
            score: 0.95 - index * 0.05,
          })),
        },
      ],
      input,
    ) as { operations: Array<{ sourceNames?: string[] }> };

    expect(result.operations).toEqual([
      expect.objectContaining({ sourceNames: ["メリア"] }),
    ]);
  });

  it("retains a real character whose name appears in the title when local grammar identifies the person", () => {
    const input = makeInput();
    input.workTitle = "転生しました、サラナ・キンジェです。ごきげんよう。";
    input.selection.text =
      'B1: source="サラナ・キンジェは領地で商売を始める。" | target=""';
    const evidence = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/sarana",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["サラナ・キンジェ"],
            targetName: "사라나 킨제",
            displayName: "사라나 킨제",
            aliases: [],
            sources: [evidence],
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: [
            {
              ...evidence,
              content: "登場人物 サラナ・キンジェ。領地で商売を始める。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<{ sourceNames?: string[] }> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({ sourceNames: ["サラナ・キンジェ"] }),
    );
  });

  it("drops a generic katakana lifestyle label even when summaries repeat it", () => {
    const input = makeInput();
    input.workTitle = "ROMANIZED ALCHEMY NOVEL";
    input.selection.text =
      'B1: source="スローライフを目指す。今度こそスローライフを送る。" | target=""';
    const sources = [
      {
        title: `${input.workTitle} | Publisher`,
        url: "https://publisher.example/work/alchemy",
      },
      {
        title: `${input.workTitle} | Reader`,
        url: "https://reader.example/title/alchemy",
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "スローライフ",
            target: "슬로 라이프",
            category: "term",
            aliases: [],
            sources,
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 設定 用語`,
          credits: 1,
          results: sources.map((source, index) => ({
            ...source,
            content: "主人公はスローライフを目指す。",
            score: 0.95 - index * 0.05,
          })),
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops a creator alias proposed as a glossary term", () => {
    const input = makeInput();
    input.workTitle = "月明かりの錬金術師は辺境で暮らす";
    input.selection.text =
      'B1: source="原作: YASOU Teien" | target=""\n' +
      `B2: source="${input.workTitle}" | target=""`;
    const evidence = {
      title: `${input.workTitle} | 出版社公式`,
      url: "https://publisher.example/work/moonlit-alchemist",
    };
    const searches = [
      {
        query: `"${input.workTitle}" "YASOU Teien"`,
        credits: 1,
        results: [
          {
            ...evidence,
            content: `著者: YASOU Teien（夜想庭園）。${input.workTitle}。`,
            score: 0.95,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "夜想庭園",
            target: "야소 정원",
            category: "other",
            aliases: [],
            sources: [evidence],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops a Japanese candidate found only as a truncated part of a longer local token", () => {
    const input = makeInput();
    input.workTitle = "破滅ルートからの生還";
    input.selection.text =
      'B1: source="破滅エンド間違いを避け、「破滅エンド」を回避する。" | target=""';
    const evidence = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/escape",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 設定 用語`,
        credits: 1,
        results: [
          {
            ...evidence,
            content:
              "破滅エンド間違いを避ける物語。作中では「破滅エンド」と呼ばれる。",
            score: 0.95,
          },
        ],
      },
    ];
    const operation = (source: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source,
      target,
      category: "term",
      aliases: [],
      sources: [evidence],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          operation("エンド間違", "엔딩 실수"),
          operation("破滅エンド", "파멸 엔딩"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "エンド間違" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ source: "破滅エンド" }),
    );
  });

  it("keeps a protagonist identified by a post-name role phrase and drops an unsupported name", () => {
    const input = makeInput();
    input.workTitle = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    const source = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/idle-game",
    };
    const searches = [
      {
        query: `"${input.workTitle}" あらすじ`,
        credits: 1,
        results: [
          {
            ...source,
            content:
              "プログラマーは異世界でジークという子供に転生した。放置ゲー理論で最強を目指す。",
            score: 0.95,
          },
        ],
      },
    ];
    const character = (name: string, targetName: string) => ({
      entity: "character",
      action: "add",
      sourceNames: [name],
      targetName,
      displayName: targetName,
      aliases: [],
      sources: [source],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("ジーク", "지크"),
          character("エース", "에이스"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ sourceNames?: string[] }> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({ sourceNames: ["ジーク"] }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ sourceNames: ["エース"] }),
    );
  });

  it("drops magazine names, magazine fragments, creator credits, and generic slang", () => {
    const input = makeInput();
    input.workTitle = "最弱貴族に転生したので悪役たちを集めてみた";
    const source = {
      title: `${input.workTitle} | 作品情報`,
      url: "https://publisher.example/work/weak-noble",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 作品情報`,
        credits: 1,
        results: [
          {
            ...source,
            content:
              "掲載誌は月刊少年シリウス。イラスト：ファルまろ。バリ立という一般表現。",
            score: 0.95,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["シリウス"],
            targetName: "시리우스",
            displayName: "시리우스",
            aliases: [],
            sources: [source],
          },
          ...["月刊少年シリウス", "ファルまろ", "バリ立"].map((term) => ({
            entity: "glossary",
            action: "add",
            source: term,
            target: "번역",
            category: "term",
            aliases: [],
            sources: [source],
          })),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as {
      operations: Array<{ source?: string; sourceNames?: string[] }>;
    };

    expect(result.operations).toEqual([]);
  });

  it("does not treat a dangling-bracket prose sentence as a work title", () => {
    const sentence = "Monster・Evolve・Online】、通称【MEO】を手に入れた。";
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "work title",
          credits: 1,
          results: [
            {
              title: "Roman title A",
              url: "https://a.example/work/1",
              content: `# ${sentence}`,
              score: 0.9,
            },
            {
              title: "Roman title B",
              url: "https://b.example/work/2",
              content: `# ${sentence}`,
              score: 0.85,
            },
          ],
        },
      ]),
    ).not.toContain(sentence);
    expect(
      extractCorroboratedEvidenceTitles([
        {
          query: "work title",
          credits: 1,
          results: [
            {
              title: "Official A",
              url: "https://a.example/work/1",
              content: "# 異世界×放置ゲー=最強!?",
              score: 0.9,
            },
            {
              title: "Official B",
              url: "https://b.example/work/2",
              content: "# 異世界×放置ゲー=最強!?",
              score: 0.85,
            },
          ],
        },
      ]),
    ).not.toContain("異世界×放置ゲー=最強!?");
  });

  it("drops generic web words and title fragments misclassified as characters", () => {
    const input = makeInput();
    input.workTitle = "KUZULESSE OBLIGE: 18-KIN GAME SEKAI";
    input.selection.text =
      'B1: source="主人公ウルトスはクズレス・オブリージュの世界でクズムーブを繰り返す。" | target=""';
    const title =
      "クズレス・オブリージュ 18禁ゲー世界のクズ悪役に転生してしまった俺は、原作知識の力でどうしてもモブ人生をつかみ取りたい";
    const sourceA = {
      title: `${title} | 出版社公式`,
      url: "https://publisher.example/work/1",
    };
    const sourceB = {
      title: `${title} | 公式配信`,
      url: "https://reader.example/work/1",
    };
    const searches = [
      {
        query: `"${title}" 登場人物 キャラクター`,
        credits: 1,
        results: [sourceA, sourceB].map((source, index) => ({
          ...source,
          content: `${title}。主人公ウルトス。スカッと爽快。ヒーローウルトスが活躍。作品トークも掲載。`,
          score: 0.9 - index * 0.05,
        })),
      },
    ];
    const character = (
      name: string,
      target: string,
      action: "add" | "update" = "add",
    ) => ({
      entity: "character",
      action,
      sourceNames: [name],
      targetName: target,
      displayName: target,
      aliases: [],
      sources: [sourceA, sourceB],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("ウルトス", "우르토스"),
          character("トーク", "지크", "update"),
          character("ビジュアル", "비주얼"),
          character("クズムーブ", "쿠즈 무브"),
          character("クズレス", "쿠즈토스", "update"),
          character("スカッ", "시원한"),
          character("ヒーローウルトス", "히어로 우르토스"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      entity: "character",
      sourceNames: ["ウルトス"],
      targetName: "우르토스",
    });
  });

  it("removes a generic Korean role from an evidenced character name", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    const source = {
      title: `${input.workTitle} | 出版社公式`,
      url: "https://publisher.example/work/1",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ハルク"],
            targetName: "히어로 하르크",
            displayName: "히어로 하르크",
            aliases: [],
            sources: [source],
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: [
            {
              ...source,
              content: "主人公ハルクは旅に出る。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["ハルク"],
        targetName: "하르크",
        displayName: "하르크",
      }),
    );
  });

  it("keeps a named person but rejects roles, classes, species, and generic skill labels", () => {
    const input = makeInput();
    input.workTitle = "バグスキル【開錠】で最強最速ダンジョン攻略";
    const sourceA = {
      title: `${input.workTitle} | 出版社公式`,
      url: "https://publisher.example/work/bug-skill",
    };
    const sourceB = {
      title: `${input.workTitle} | 公式配信`,
      url: "https://reader.example/work/bug-skill",
    };
    const content = [
      input.workTitle,
      "主人公の仲間であるヒーラーがゴーレムと戦う。",
      "シェリルという名の少女が登場する。",
      "最弱スキルから成長する物語。",
      "第二王女セレナ、妻サーシャ、イケオジ公爵は一切興味を示さない。",
    ].join("\n");
    const searches = [
      {
        query: `"${input.workTitle}" 登場人物 キャラクター`,
        credits: 1,
        results: [sourceA, sourceB].map((source, index) => ({
          ...source,
          content,
          score: 0.9 - index * 0.05,
        })),
      },
    ];
    const character = (name: string, target: string) => ({
      entity: "character",
      action: "add",
      sourceNames: [name],
      targetName: target,
      displayName: target,
      aliases: [],
      sources: [sourceA, sourceB],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("仲間", "동료"),
          character("ヒーラー", "힐러"),
          character("ゴーレム", "고렘"),
          character("シェリル", "셰릴"),
          {
            entity: "glossary",
            action: "add",
            source: "最弱スキル",
            target: "최약 스킬",
            category: "term",
            aliases: [],
            sources: [sourceA, sourceB],
          },
          ...[
            ["第二王女セレナ", "제2왕녀 세레나"],
            ["妻サーシャ", "아내 사샤"],
            ["イケオジ公爵", "멋진 중년 공작"],
            ["一切興味", "전혀 관심 없음"],
          ].map(([source, target]) => ({
            entity: "glossary",
            action: "add",
            source,
            target,
            category: "term",
            aliases: [],
            sources: [sourceA, sourceB],
          })),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      entity: "character",
      sourceNames: ["シェリル"],
      targetName: "셰릴",
    });
  });

  it("suggests only AI generic character profiles for cautious pruning", () => {
    const input = makeInput();
    const character = (
      id: string,
      sourceName: string,
      origin: "ai" | "manual",
    ) => ({
      id,
      displayName: sourceName,
      sourceNames: [sourceName],
      targetName: sourceName,
      speechStyle: "neutral" as const,
      origin,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    input.guide.characters = [
      character("ai-role", "父親", "ai"),
      character("ai-abstract", "将来", "ai"),
      character("manual-role", "侍女", "manual"),
      character("ai-name", "シェリル", "ai"),
    ];

    const result = enrichResearchResultFromEvidence(
      { operations: [], warnings: [] },
      [],
      input,
    ) as {
      operations: Array<{
        action: string;
        entryId: string;
        confidence: string;
      }>;
    };

    expect(result.operations).toEqual([
      expect.objectContaining({
        action: "disable",
        entryId: "ai-role",
        confidence: "medium",
      }),
      expect.objectContaining({
        action: "disable",
        entryId: "ai-abstract",
        confidence: "medium",
      }),
    ]);
  });

  it("merges a Latin compound's initialism into the glossary aliases", () => {
    const input = makeInput();
    input.workTitle = "スライムマスターちゃんのVRMMO";
    input.selection.text =
      'B1: source="Monster・Evolve・Online、通称MEOを始める。" | target=""';
    const source = {
      title: `${input.workTitle} | 公式配信`,
      url: "https://publisher.example/work/1",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 用語`,
        credits: 1,
        results: [
          {
            ...source,
            content: "Monster・Evolve・Online、通称MEO。",
            score: 0.9,
          },
        ],
      },
    ];
    const glossary = (term: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source: term,
      target,
      category: "term",
      aliases: [],
      sources: [source],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          glossary("Monster・Evolve・Online", "몬스터·이볼브·온라인"),
          glossary("MEO", "MEO"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({
      entity: "glossary",
      source: "Monster・Evolve・Online",
      target: "몬스터·이볼브·온라인",
      aliases: ["MEO"],
    });
  });

  it("drops an external character found only on an unrelated direct work page", () => {
    const input = makeInput();
    input.workTitle = "正しい作品名";
    input.selection.text = 'B1: source="固有用語" | target="고유 용어"';
    const unrelatedSource = {
      title: "別作品の公式漫画",
      url: "https://reader.example/comic/other",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["エース"],
            targetName: "에이스",
            displayName: "에이스",
            aliases: [],
            sources: [unrelatedSource],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"正しい作品名" 登場人物',
          credits: 1,
          results: [
            {
              ...unrelatedSource,
              content: "関連作品: 正しい作品名。別作品の主人公エース。",
              score: 0.8,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("keeps work-bound lead characters while rejecting unrelated names and page debris", () => {
    const input = makeInput();
    input.workTitle =
      "泣いて謝られても教会には戻りません！～追放された元聖女候補ですが、同じく追放された『剣神』さまと意気投合したので第二の人生を始めてます～";
    input.selection.text = "";
    const correctSource = {
      title: "泣いて謝られても教会には戻りません！ 公式作品ページ",
      url: "https://publisher.example/work/saint",
    };
    const unrelatedSource = {
      title: "私を追放した教会には戻りません！ 公式作品ページ",
      url: "https://publisher.example/work/other",
    };
    const character = (
      sourceName: string,
      targetName: string,
      source: typeof correctSource,
    ) => ({
      entity: "character",
      action: "add",
      sourceNames: [sourceName],
      targetName,
      displayName: targetName,
      aliases: [],
      sources: [source],
    });
    const glossary = (
      source: string,
      target: string,
      evidence: typeof correctSource,
    ) => ({
      entity: "glossary",
      action: "add",
      source,
      target,
      category: "term",
      aliases: [],
      sources: [evidence],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          character("セルビア", "세르비아", correctSource),
          character("ハルク", "헐크", correctSource),
          character("ピッコマ", "피코마", correctSource),
          character("メーター", "미터", correctSource),
          character("アリシア", "아리시아", unrelatedSource),
          glossary("第1話", "제1화", correctSource),
          glossary("一覧", "목록", correctSource),
          glossary("女は働くな", "여자는 일하지 마라", unrelatedSource),
          glossary("金色の獅子", "황금빛 사자", unrelatedSource),
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: [
            {
              ...correctSource,
              content:
                "元聖女候補セルビアは、最強の剣士ハルクと出会う。ピッコマで配信。読書メーターでも紹介。第1話 一覧。",
              score: 0.9,
            },
            {
              ...unrelatedSource,
              content:
                "別作品の主人公アリシア。金色の獅子。試し読み 女は働くな。",
              score: 0.98,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(
      result.operations.flatMap((operation) =>
        Array.isArray(operation.sourceNames) ? operation.sourceNames : [],
      ),
    ).toEqual(["セルビア", "ハルク"]);
    expect(result.operations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "第1話" }),
        expect.objectContaining({ source: "一覧" }),
        expect.objectContaining({ source: "女は働くな" }),
        expect.objectContaining({ source: "金色の獅子" }),
      ]),
    );
  });

  it("drops role-decorated character labels from the glossary", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    input.selection.text =
      'B1: source="美少女メイド・アネットと不肖リエラ" | target=""';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "美少女メイド・アネット",
            target: "미소녀 메이드 아네트",
            category: "term",
            aliases: [],
            sources: [
              {
                title: "汎用作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
          {
            entity: "glossary",
            action: "add",
            source: "不肖リエラ",
            target: "불초 리에라",
            category: "character",
            aliases: [],
            sources: [
              {
                title: "汎用作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"汎用作品名" 公式',
          credits: 1,
          results: [
            {
              title: "汎用作品名 公式",
              url: "https://publisher.example/work/1",
              content: "美少女メイド・アネットが戦う。不肖リエラも登場する。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ entity: "glossary" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["リエラ"],
        targetName: "리에라",
      }),
    );
  });

  it("moves a glued role prefix out of a character's canonical name", () => {
    const input = makeInput();
    input.workTitle = "最弱貴族に転生したので悪役たちを集めてみた";
    input.selection.text =
      'B1: source="最弱貴族アデルは悪役たちを集める。" | target=""';
    const source = {
      title: `${input.workTitle} | 公式`,
      url: "https://publisher.example/work/weakest-noble",
    };
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["最弱貴族アデル", "アデル"],
            targetName: "아델",
            displayName: "아델",
            aliases: [],
            sources: [source],
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" 登場人物`,
          credits: 1,
          results: [
            {
              ...source,
              content: "最弱貴族アデルは悪役たちを集める。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["アデル"],
        aliases: ["最弱貴族アデル"],
      }),
    );
  });

  it("drops a short sentence tagline and terms found only in related-work sections", () => {
    const input = makeInput();
    input.workTitle = "死神騎士は運命の婚約者を離さない";
    input.selection.text = 'B1: source="死神騎士" | target=""';
    const searches = [
      {
        query: '"死神騎士は運命の婚約者を離さない" 公式',
        credits: 1,
        results: [
          {
            title: "死神騎士は運命の婚約者を離さない | 公式",
            url: "https://publisher.example/work/1",
            content:
              "君じゃなきゃダメだ。死神騎士とエメリーンの物語。\n関連小説\n姉の身代わりで嫁いだ残りカス令嬢。",
            score: 0.95,
          },
          {
            title: "別作品のページ",
            url: "https://reader.example/work/2",
            content: "関連作品\n残りカス令嬢の物語。",
            score: 0.7,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "君じゃなきゃダメだ",
            target: "너 아니면 안 돼",
            category: "term",
            aliases: [],
            sources: [
              {
                title: "死神騎士は運命の婚約者を離さない | 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
          {
            entity: "glossary",
            action: "add",
            source: "カス令",
            target: "쓰레기 영애",
            category: "term",
            aliases: [],
            sources: searches[0]?.results.map(({ title, url }) => ({
              title,
              url,
            })),
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops a full katakana name whose Korean target omits the surname", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    input.selection.text = 'B1: source="アーノイック" | target=""';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["歴代最強の剣聖・アーノイック", "アーノイック"],
            targetName: "아르노익",
            displayName: "아르노익",
            aliases: [],
            sources: [
              {
                title: "汎用作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"汎用作品名" 登場人物',
          credits: 1,
          results: [
            {
              title: "汎用作品名 公式",
              url: "https://publisher.example/work/1",
              content:
                "歴代最強の剣聖・アーノイック。本名はアーノイック・ブルシュトローム。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("turns official full names and a locally anchored reading into exact operations", () => {
    const input = makeInput();
    input.workTitle = "汎用作品名";
    input.selection.text = [
      'B1: source="イングリス" | ko="잉글리스"',
      'B2: source="レオーネ" | ko="레오네"',
      'B3: source="ハイラルメナス" | ko="하이랄 메너스"',
    ].join("\n");
    const searches = [
      {
        query: '"汎用作品名" 登場人物',
        credits: 1,
        results: [
          {
            title: "CHARACTER | 汎用作品名",
            url: "https://anime.example/character/",
            content:
              "イングリス・ユークス。ラフィニア・ビルフォード。レオーネ・オルファー。",
            score: 0.9,
          },
        ],
      },
      {
        query: '"汎用作品名" "ハイラル・メナス"',
        credits: 1,
        results: [
          {
            title: "汎用作品名 公式記事",
            url: "https://anime.example/article/1",
            content: "天恵武姫（ハイラル・メナス）の力を使う。",
            score: 0.85,
          },
        ],
      },
    ];

    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );
    expect(candidates).toEqual(
      expect.arrayContaining([
        "イングリス・ユークス",
        "ラフィニア・ビルフォード",
        "レオーネ・オルファー",
        "天恵武姫（ハイラル・メナス）",
      ]),
    );

    const operations = buildTranslatedCriticalEvidenceOperations(
      [
        {
          source: "イングリス・ユークス",
          target: "잉글리스 유크스",
        },
        {
          source: "ラフィニア・ビルフォード",
          target: "라피니아 빌포드",
        },
        {
          source: "レオーネ・オルファー",
          target: "레오네 올파",
        },
        {
          source: "天恵武姫（ハイラル・メナス）",
          target: "천혜무희",
        },
      ],
      searches,
      input,
    );
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["ラフィニア・ビルフォード"],
          targetName: "라피니아 빌포드",
        }),
        expect.objectContaining({
          entity: "glossary",
          source: "天恵武姫",
          target: "천혜무희",
          aliases: ["ハイラル・メナス"],
        }),
      ]),
    );
    expect(
      buildTranslatedCriticalEvidenceOperations(
        [{ source: "ラフィニア・ビルフォード", target: "라피니아" }],
        searches,
        input,
        candidates,
      ),
    ).toEqual([]);
  });

  it("recovers a plain web-only name when the evidence explicitly binds it to a role", () => {
    const input = makeInput();
    input.workTitle = "作品名";
    input.selection.text = 'B1: source="ロッド" | ko="로드"';
    const searches = [
      {
        query: '"作品名" 登場人物',
        credits: 1,
        results: [
          {
            title: "作品名 作品紹介",
            url: "https://publisher.example/work/1",
            content: "少年ロッドは迷宮神ラヴィと出会う。",
            score: 0.9,
          },
        ],
      },
    ];

    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );
    expect(candidates).toEqual(expect.arrayContaining(["ロッド", "ラヴィ"]));
    expect(
      buildTranslatedCriticalEvidenceOperations(
        [
          { source: "ロッド", target: "로드" },
          { source: "ラヴィ", target: "라비" },
        ],
        searches,
        input,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "character",
          sourceNames: ["ラヴィ"],
          targetName: "라비",
        }),
      ]),
    );
  });

  it("extracts full character names quoted after narrative roles", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text = 'B1: source="黒歴史" | ko="흑역사"';
    const searches = [
      {
        query: '"転生悪女の黒歴史" 登場人物 キャラクター',
        credits: 1,
        results: [
          {
            title: "TVアニメ『転生悪女の黒歴史』公式サイト",
            url: "https://anime.example/",
            content:
              "主人公『コノハ・マグノリア』が活躍する。稀代の悪女『イアナ・マグノリア』に転生してしまう。",
            score: 0.95,
          },
        ],
      },
    ];

    expect(
      selectCriticalEvidenceTranslationCandidates([], searches, input),
    ).toEqual(
      expect.arrayContaining(["コノハ・マグノリア", "イアナ・マグノリア"]),
    );
  });

  it("recovers an isolated name from a direct work page returned by a character search", () => {
    const input = makeInput();
    input.workTitle = "作品名";
    input.selection.text = 'B1: source="ロッド" | ko="로드"';
    const searches = [
      {
        query: '"作品名" 登場人物',
        credits: 1,
        results: [
          {
            title: "作品名 作品公式ページ",
            url: "https://publisher.example/series/1",
            content: "登場人物\nラヴィ\n[迷宮を作った神]",
            score: 0.9,
          },
        ],
      },
    ];

    const candidates = selectCriticalEvidenceTranslationCandidates(
      [],
      searches,
      input,
    );
    expect(candidates).toContain("ラヴィ");
    expect(
      buildTranslatedCriticalEvidenceOperations(
        [{ source: "ラヴィ", target: "라비" }],
        searches,
        input,
      ),
    ).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ラヴィ"],
        targetName: "라비",
      }),
    );
  });

  it("keeps a full name found on a direct character page from a general work search", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text = 'B1: source="黒歴史" | target="흑역사"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["イアナ・マグノリア"],
            targetName: "이아나 마그놀리아",
            displayName: "이아나 마그놀리아",
            aliases: [],
            sources: [
              {
                title: "公式キャラクター",
                url: "https://anime.example/character/iana-magnolia",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"転生悪女の黒歴史" 公式',
          credits: 1,
          results: [
            {
              title: "公式キャラクター | 転生悪女の黒歴史",
              url: "https://anime.example/character/iana-magnolia",
              content: "イアナ・マグノリア",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["イアナ・マグノリア"],
        targetName: "이아나 마그놀리아",
      }),
    );
  });

  it("maps a damaged local bracket term to the translated work-title bracket", () => {
    const input = makeInput();
    input.selection.text =
      'B1: source="バグスキル【開錠】で最強最速ダンジョン攻略" | ko="버그 스킬 【해제】로 최강 최속 던전 공략"\n' +
      'B2: source="アッロ【開錠】" | ko="OCR 문맥"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "開錠(アンロック)",
            target: "개쇄",
            aliases: [],
            sources: [
              {
                title: "作品公式ページ",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: "official",
          credits: 1,
          results: [
            {
              title: "作品公式ページ",
              url: "https://publisher.example/work/1",
              content:
                "バグスキル【開錠】で最強最速ダンジョン攻略。開錠（アンロック）。",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        source: "開錠",
        target: "해제",
        aliases: ["アンロック"],
      }),
    );
  });

  it("prefers the complete Korean target when a short name expands to an official full name", () => {
    const input = makeInput();
    input.workTitle = "作品名";
    input.selection.text = 'B1: source="イングリス" | ko="잉글리스"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["イングリス"],
            targetName: "잉글리스",
            displayName: "잉글리스",
            aliases: [],
            sources: [],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["イングリス・ユークス"],
            targetName: "잉글리스 유크스",
            displayName: "잉글리스 유크스",
            aliases: [],
            sources: [
              {
                title: "CHARACTER | 作品名",
                url: "https://anime.example/chara/",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"作品名" 登場人物',
          credits: 1,
          results: [
            {
              title: "CHARACTER | 作品名",
              url: "https://anime.example/chara/",
              content: "主人公 イングリス・ユークス",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    const characters = result.operations.filter(
      (operation) => operation.entity === "character",
    );
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({
      sourceNames: ["イングリス・ユークス"],
      targetName: "잉글리스 유크스",
    });
  });

  it("repairs a one-character typo in a full name from its official short alias", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text = 'B1: source="イアナ" | ko="이아나"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["イアヤ・マグノリア", "イアナ"],
            targetName: "이아나 마그놀리아",
            displayName: "이아나 마그놀리아",
            aliases: [],
            sources: [
              {
                title: "公式キャラクター",
                url: "https://anime.example/character/iana",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"転生悪女の黒歴史" 登場人物 キャラクター',
          credits: 1,
          results: [
            {
              title: "公式キャラクター | 転生悪女の黒歴史",
              url: "https://anime.example/character/iana",
              content: "主人公 イアナ・マグノリア。稀代の悪女。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["イアナ・マグノリア", "イアナ"],
        aliases: ["イアヤ・マグノリア"],
      }),
    );
  });

  it("repairs an adjacent duplicated Korean mora in a complete katakana name", () => {
    const input = makeInput();
    input.workTitle = "転生悪女の黒歴史";
    input.selection.text = 'B1: source="コノハ" | ko="코노하"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["コノハ・マグノリア"],
            targetName: "코코하 마그놀리아",
            displayName: "코코하 마그놀리아",
            aliases: [],
            sources: [
              {
                title: "公式キャラクター",
                url: "https://anime.example/character/konoha",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"転生悪女の黒歴史" 登場人物 キャラクター',
          credits: 1,
          results: [
            {
              title: "公式キャラクター | 転生悪女の黒歴史",
              url: "https://anime.example/character/konoha",
              content: "主人公『コノハ・マグノリア』。イアナの妹。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["コノハ・マグノリア"],
        targetName: "코노하 마그놀리아",
        displayName: "코노하 마그놀리아",
      }),
    );
  });

  it("removes an unsupported final consonant from a simple katakana name", () => {
    const input = makeInput();
    input.workTitle = "作品名";
    input.selection.text = 'B1: source="ロザレナ" | ko="로자레나"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ロザレナ"],
            targetName: "로잘레나",
            displayName: "로잘레나",
            aliases: [],
            sources: [
              {
                title: "作品名 公式",
                url: "https://publisher.example/work/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: '"作品名" 登場人物',
          credits: 1,
          results: [
            {
              title: "作品名 公式",
              url: "https://publisher.example/work/1",
              content: "登場人物ロザレナ。",
              score: 0.95,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        sourceNames: ["ロザレナ"],
        targetName: "로자레나",
        displayName: "로자레나",
      }),
    );
  });

  it("keeps a reading as an alias instead of duplicating it in the Korean target", () => {
    const input = makeInput();
    input.workTitle = "汎用テスト作品名";
    input.selection.text = 'B1: source="ハイラルメナス" | ko="하이랄 메너스"';
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "天恵武姫",
            target: "천혜무희(하이랄 메나스)",
            aliases: ["ハイラル・メナス"],
            sources: [
              {
                title: `${input.workTitle} | 公式記事`,
                url: "https://publisher.example/article/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: `"${input.workTitle}" "ハイラル・メナス"`,
          credits: 1,
          results: [
            {
              title: `${input.workTitle} | 公式記事`,
              url: "https://publisher.example/article/1",
              content: "天恵武姫（ハイラル・メナス）",
              score: 0.9,
            },
          ],
        },
      ],
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        source: "天恵武姫",
        target: "천혜무희",
        aliases: ["ハイラル・メナス"],
      }),
    );
  });

  it("drops a web-only glossary item that is not bound to the researched work", () => {
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "アナハイム・エレクトロニクス",
            target: "애너하임 일렉트로닉스",
            sources: [
              {
                title: "무관한 질문",
                url: "https://questions.example/item/1",
              },
            ],
          },
        ],
        warnings: [],
      },
      [
        {
          query: "local candidate collision",
          credits: 1,
          results: [
            {
              title: "무관한 질문",
              url: "https://questions.example/item/1",
              content: "アナハイム・エレクトロニクスについての質問。",
              score: 0.9,
            },
          ],
        },
      ],
      makeInput(),
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "アナハイム・エレクトロニクス" }),
    );
  });

  it("drops a web-only term supported only by one weak page plus social media", () => {
    const input = makeInput();
    const title = "汎用的な日本語作品タイトル";
    input.workTitle = title;
    const term = "アストランティア警備保障";
    const searches = [
      {
        query: `"${title}" 設定 用語`,
        credits: 1,
        results: [
          {
            title: `${title} | 百科事典`,
            url: "https://dictionary.example/a/entry",
            content: `${title} ${term}`,
            score: 0.8,
          },
          {
            title,
            url: "https://x.com/example/status/1",
            content: `${title} ${term}`,
            score: 0.7,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: term,
            target: "아스트란티아 경비 보장",
            category: "term",
            aliases: [],
            sources: searches[0]?.results.map(
              ({ title: sourceTitle, url }) => ({
                title: sourceTitle,
                url,
              }),
            ),
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: term }),
    );
  });

  it("drops generic craft vocabulary while retaining work-specific setting terms", () => {
    const input = makeInput();
    input.workTitle = "魔導細工師ノーミィの異世界クラフト生活";
    input.selection.text =
      'B1: source="魔導細工師ノーミィはハーフドワーフの少女。ドワーフ村を追放され、魔王城でクラフト生活を始める。魔族のホワイトも登場する。" | target=""';
    const sources = [
      {
        title: `${input.workTitle} | 公式作品ページ`,
        url: "https://publisher.example/work/nomy",
      },
    ];
    const searches = [
      {
        query: `"${input.workTitle}" 用語`,
        credits: 1,
        results: [
          {
            ...sources[0],
            content:
              "魔導細工師ノーミィはハーフドワーフの少女。ドワーフ村を追放され、魔王城でクラフト生活を始める。魔族のホワイトも登場する。",
            score: 0.9,
          },
        ],
      },
    ];
    const operation = (source: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source,
      target,
      category: "term",
      aliases: [],
      sources,
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          operation("クラフト", "크래프트"),
          operation("クラフト生活", "크래프트 생활"),
          operation("魔族", "마족"),
          operation("ホワイト", "화이트"),
          operation("ゲー世界", "게임 세계"),
          operation("Sランク", "S랭크"),
          operation("禁ゲー", "금겜"),
          operation("マイナススタート", "마이너스 스타트"),
          operation("魔導細工師", "마도 세공사"),
          operation("魔王城", "마왕성"),
          operation("ハーフドワーフ", "하프 드워프"),
          operation("ドワーフ村", "드워프 마을"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations.map(({ source }) => source)).toEqual(
      expect.arrayContaining(["ハーフドワーフ", "ドワーフ村"]),
    );
    expect(result.operations.map(({ source }) => source)).not.toEqual(
      expect.arrayContaining([
        "クラフト",
        "クラフト生活",
        "魔族",
        "ホワイト",
        "ゲー世界",
        "Sランク",
        "禁ゲー",
        "マイナススタート",
      ]),
    );
  });

  it("drops unnamed role labels and merges terminal katakana abbreviations", () => {
    const input = makeInput();
    input.workTitle = "異世界に放置ゲー理論を持ち込んだら世界最強になれる説";
    input.selection.text =
      'B1: source="異世界に転生したおっさんこと主人公ジークが、天輪:四重奏を使い、放置ゲームを放置ゲーシステムとして確立する。" | target=""';
    const evidence = {
      title: `${input.workTitle} | 公式`,
      url: "https://publisher.example/work/houchi-game",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 設定 用語`,
        credits: 1,
        results: [
          {
            ...evidence,
            content:
              "異世界に転生したおっさんこと主人公ジークが、天輪:四重奏を使い、放置ゲームを放置ゲーシステムとして確立する。",
            score: 0.9,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["おっさん"],
            targetName: "아저씨",
            displayName: "아저씨",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ジーク"],
            targetName: "지크",
            displayName: "지크",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "glossary",
            action: "add",
            source: "ジーク",
            target: "지크",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "glossary",
            action: "add",
            source: "天輪:四重奏",
            target: "천륜: 사중주(リング:カルテット)",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "glossary",
            action: "add",
            source: "放置ゲーム",
            target: "방치형 게임",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "glossary",
            action: "add",
            source: "放置ゲー",
            target: "방치겜",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
          {
            entity: "glossary",
            action: "add",
            source: "ゲー理論",
            target: "게임 이론",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ sourceNames: ["おっさん"] }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "ゲー理論" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "ジーク" }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "天輪:四重奏" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ sourceNames: ["ジーク"] }),
    );
    const baseTermOperations = result.operations.filter(
      (operation) =>
        operation.source === "放置ゲーム" || operation.source === "放置ゲー",
    );
    expect(baseTermOperations).toHaveLength(1);
    expect(baseTermOperations[0]?.aliases).toEqual(
      expect.arrayContaining(["放置ゲー"]),
    );
  });

  it("repairs English targets when a romanized folder title recovers Japanese evidence", () => {
    const input = makeInput();
    input.workTitle =
      "Tada no Murabito no Boku ga Sanbyakunen Mae no Boukun Ouji";
    input.selection.text =
      'B1: source="皇子ルドルフが未来を変える。" | target=""\n' +
      'B2: source="原作: Sanbon / 作画: Tasuke" | target=""';
    const title = "ただの村人の僕が、三百年前の暴君皇子に転生してしまいました";
    const searches = [
      {
        query: '"Tada no Murabito no Boku" 原題 日本語 公式',
        credits: 1,
        results: [
          {
            title: `${title} | 出版社公式`,
            url: "https://publisher.example/products/123",
            content: "皇子ルドルフが暗殺の未来を変える物語。",
            score: 0.9,
          },
          {
            title: `${title} | 公式配信`,
            url: "https://reader.example/works/456",
            content: "主人公ルドルフを描く作品。",
            score: 0.85,
          },
        ],
      },
    ];
    const initialOperations = [
      {
        entity: "glossary",
        action: "add",
        source: title,
        target: "A Mere Villager Reincarnated as a Tyrant Prince",
        sources: [
          {
            title: `${title} | 出版社公式`,
            url: "https://publisher.example/products/123",
          },
        ],
      },
      {
        entity: "character",
        action: "add",
        sourceNames: ["皇子ルドルフ"],
        targetName: "Prince Rudolf",
        sources: [
          {
            title: `${title} | 出版社公式`,
            url: "https://publisher.example/products/123",
          },
        ],
      },
      {
        entity: "glossary",
        action: "add",
        source: "Sanbon",
        target: "산본",
        sources: [
          {
            title: `${title} | 出版社公式`,
            url: "https://publisher.example/products/123",
          },
        ],
      },
    ];
    const candidates = selectCriticalEvidenceTranslationCandidates(
      initialOperations,
      searches,
      input,
    );
    expect(candidates).toContain("ルドルフ");
    expect(candidates).not.toContain(title);
    const repaired = buildTranslatedCriticalEvidenceOperations(
      [
        {
          source: title,
          target: "평범한 마을 사람인 내가 폭군 황자로 환생했습니다",
        },
        { source: "ルドルフ", target: "루돌프" },
      ],
      searches,
      input,
      candidates,
    );
    const result = enrichResearchResultFromEvidence(
      { operations: [...initialOperations, ...repaired], warnings: [] },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ entity: "glossary", source: title }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ルドルフ"],
        targetName: "루돌프",
      }),
    );
    expect(JSON.stringify(result.operations)).not.toMatch(
      /Prince Rudolf|A Mere Villager/u,
    );
    expect(JSON.stringify(result.operations)).not.toMatch(/Sanbon/u);
  });

  it("drops an obviously truncated decoration after an evidenced work title", () => {
    const input = makeInput();
    const title = "星海の案内人は古都で眠る";
    input.workTitle = "Generic Latin Folder";
    input.selection.text = `B1: source="${title}" | target="별바다의 안내인은 고도에서 잠든다"`;
    const searches = ["publisher-a.example", "catalog-b.example"].map(
      (host) => ({
        query: `"${title}"`,
        credits: 1,
        results: [
          {
            title: `${title} | 公式作品ページ`,
            url: `https://${host}/work/1`,
            content: `作品名：${title}`,
            score: 0.9,
          },
        ],
      }),
    );
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: `${title}【...")`,
            target: "별바다의 안내인은 고도에서 잠든다",
            category: "other",
            aliases: [],
            sources: searches.map(({ results }) => ({
              title: results[0]?.title ?? "",
              url: results[0]?.url ?? "",
            })),
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });

  it("drops a partial title fragment unless evidence uses it independently", () => {
    const input = makeInput();
    const title = "星巡りの秘術師と蒼天領域";
    input.workTitle = title;
    input.selection.text =
      `B1: source="${title}" | target="작품명"\n` +
      'B2: source="秘術師が「星環術」を使う" | target=""';
    const evidence = {
      title: `${title} | 公式作品ページ`,
      url: "https://publisher.example/work/star-cycle",
    };
    const searches = [
      {
        query: `"${title}" 用語`,
        credits: 1,
        results: [
          {
            ...evidence,
            content: `作品紹介：${title}。秘術師が「星環術」を使う。`,
            score: 0.9,
          },
        ],
      },
    ];
    const operation = (source: string, target: string) => ({
      entity: "glossary",
      action: "add",
      source,
      target,
      category: "term",
      aliases: [],
      sources: [evidence],
    });
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          operation("蒼天領", "창천령"),
          operation("星環術", "성환술"),
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<{ source?: string }> };

    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ source: "蒼天領" }),
    );
    expect(result.operations).toContainEqual(
      expect.objectContaining({ source: "星環術" }),
    );
  });

  it("reclassifies a short glossary candidate when work-bound evidence names a character", () => {
    const input = makeInput();
    input.workTitle = "月影工房の物語";
    input.selection.text =
      'B1: source="相棒のルミナちゃんが工房に加わる。" | target=""';
    const evidence = {
      title: `${input.workTitle} | 公式作品ページ`,
      url: "https://publisher.example/work/moonlit-workshop",
    };
    const searches = [
      {
        query: `"${input.workTitle}" 登場人物`,
        credits: 1,
        results: [
          {
            ...evidence,
            content: "主人公の相棒、ルミナちゃんが工房に加わる。",
            score: 0.9,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "ルミナ",
            target: "루미나",
            category: "term",
            aliases: [],
            sources: [evidence],
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        entity: "character",
        sourceNames: ["ルミナ"],
        targetName: "루미나",
      }),
    );
    expect(result.operations).not.toContainEqual(
      expect.objectContaining({ entity: "glossary", source: "ルミナ" }),
    );
  });

  it("drops a title carrying an arbitrary imprint suffix", () => {
    const input = makeInput();
    const title = "銀河の仕立師は王都を旅する";
    const decorated = `${title}（星雲ノベル）`;
    input.workTitle = "Romanized Folder Title";
    input.selection.text = `B1: source="${title}" | target="은하의 재단사는 왕도를 여행한다"`;
    const searches = [
      {
        query: "native title",
        credits: 1,
        results: [
          {
            title: decorated,
            url: "https://store.example/book/1",
            content: `${decorated} 作品紹介`,
            score: 0.9,
          },
          {
            title: `${title} | 公式作品ページ`,
            url: "https://publisher.example/work/1",
            content: `${title} 作品紹介`,
            score: 0.9,
          },
        ],
      },
    ];
    const result = enrichResearchResultFromEvidence(
      {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: decorated,
            target: "은하의 재단사는 왕도를 여행한다 (성운 노벨)",
            category: "other",
            aliases: [],
            sources: searches[0]?.results.map(
              ({ title: sourceTitle, url }) => ({
                title: sourceTitle,
                url,
              }),
            ),
          },
        ],
        warnings: [],
      },
      searches,
      input,
    ) as { operations: Array<Record<string, unknown>> };

    expect(result.operations).toEqual([]);
  });
});

function makeInput(): WorkContextResearchPromptInput {
  return {
    workTitle: "버그 스킬 【해제】로 최강 최속 던전 공략",
    guide: {
      schemaVersion: 1,
      workId: "work-1",
      glossary: [],
      characters: [],
      rules: {
        honorifics: "drop",
        sfxMode: "preserve",
        defaultTone: "literal",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    selection: {
      text: 'B1: source="バグスキル【開錠】で最強最速ダンジョン攻略" | ko="버그 스킬 【해제】로 최강 최속 던전 공략"',
      basePages: [],
      coverage: {
        scope: "work",
        workId: "work-1",
        requestedChapterId: "chapter-1",
        totalChapters: 1,
        includedChapters: 1,
        totalPages: 1,
        includedPages: 1,
        selectedChars: 60,
        maxInputChars: 65_536,
        truncated: false,
      },
    },
  };
}
