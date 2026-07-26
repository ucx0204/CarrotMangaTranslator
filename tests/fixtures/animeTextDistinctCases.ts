export function distinctBalloonCandidates(): Array<Record<string, unknown>> {
  const topRegion = {
    animeTextRegionId: "ATY101",
    animeTextRegionScore: 0.865,
    animeTextRegionBbox: [316.6, 258.6, 405.3, 525.7],
  };
  const lowerRegion = {
    animeTextRegionId: "ATY102",
    animeTextRegionScore: 0.8735,
    animeTextRegionBbox: [116.5, 356.6, 291.8, 690.5],
  };
  return [
    [5, "B002", 350, 270, 400, 390, "婿入りも", 1, topRegion],
    [4, "B002", 318, 390, 405, 520, "王宮勤めも嫌で", 2, topRegion],
    [6, "B003", 245, 365, 290, 500, "薬草の研究を", 1, lowerRegion],
    [7, "B003", 205, 420, 250, 555, "続けるために", 2, lowerRegion],
    [9, "B003", 155, 500, 210, 650, "家を飛び出してきた", 3, lowerRegion],
    [8, "B003", 120, 575, 165, 685, "口なのです", 4, lowerRegion],
  ].map(
    ([id, reviewFragmentId, x1, y1, x2, y2, ocrText, reviewOrder, region]) => ({
      id,
      x1,
      y1,
      x2,
      y2,
      ocrText,
      reviewFragmentId,
      reviewStatus: "confirmed",
      reviewReasons: [],
      reviewOrder,
      reviewContextId: "RC001",
      paddleGroupId: "G002",
      animeTextContainment: 1,
      ...(region as Record<string, unknown>),
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    }),
  );
}

export function mangaFiveSingletonCandidates(): Array<Record<string, unknown>> {
  return [
    {
      id: 9,
      x1: 1096,
      y1: 408,
      x2: 1144,
      y2: 610,
      ocrText: "だめですよ",
      reviewFragmentId: "B003",
      reviewStatus: "confirmed",
      reviewReasons: [],
      reviewOrder: 1,
      reviewContextId: "RC001",
      animeTextRegionId: "ATY501",
      animeTextRegionScore: 0.8228,
      animeTextContainment: 1,
      animeTextRegionBbox: [1094.7, 407.1, 1144.2, 616.8],
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    },
    {
      id: 10,
      x1: 1016,
      y1: 523,
      x2: 1070,
      y2: 782,
      ocrText: "そそんな風に",
      reviewFragmentId: "B004",
      reviewStatus: "confirmed",
      reviewReasons: [],
      reviewOrder: 1,
      reviewContextId: "RC001",
      animeTextRegionId: "ATY502",
      animeTextRegionScore: 0.8021,
      animeTextContainment: 0.94,
      animeTextRegionBbox: [1017.1, 520.4, 1067.9, 784.8],
      animeTextEvidenceVersion: 1,
      animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
    },
  ];
}

export function mangaElevenInternalPaddleCandidates(): Array<
  Record<string, unknown>
> {
  const topRegion = {
    animeTextRegionId: "ATY601",
    animeTextRegionScore: 0.8844,
    animeTextRegionBbox: [180.7, 201.6, 355.7, 433.3],
  };
  const lowerRegion = {
    animeTextRegionId: "ATY602",
    animeTextRegionScore: 0.8754,
    animeTextRegionBbox: [83.5, 449.4, 260.3, 648],
  };
  const rows = [
    [6, 309, 207, 358, 427, "母との約束で", "G002", 0.95, topRegion],
    [7, 267, 208, 313, 392, "公にはして", "G002", 1, topRegion],
    [9, 224, 210, 267, 428, "いなかったの", "G002", 1, topRegion],
    [12, 214, 451, 262, 639, "公爵様には", "G004", 0.96, lowerRegion],
    [8, 180, 209, 226, 321, "ですが", "G002", 0.98, topRegion],
    [14, 170, 455, 218, 639, "お伝えして", "G004", 1, lowerRegion],
    [15, 128, 456, 171, 638, "おかねばと", "G004", 1, lowerRegion],
    [13, 84, 452, 127, 638, "思いまして", "G004", 1, lowerRegion],
  ];
  return rows.map(
    ([
      id,
      x1,
      y1,
      x2,
      y2,
      ocrText,
      paddleGroupId,
      animeTextContainment,
      region,
    ]) => {
      const groupRows = rows.filter((row) => row[6] === paddleGroupId);
      return {
        id,
        x1,
        y1,
        x2,
        y2,
        ocrText,
        reviewFragmentId: "B003",
        reviewStatus: "confirmed",
        reviewReasons: [],
        paddleGroupId,
        paddleOrder: groupRows.findIndex((row) => row[0] === id) + 1,
        paddleGroupSize: groupRows.length,
        animeTextContainment,
        ...(region as Record<string, unknown>),
        animeTextEvidenceVersion: 1,
        animeTextModelRevision: "937f67dfe61fc4793549782e103751fdc1f0a8d9",
      };
    },
  );
}

export function distinctUpstreamFragments(): Array<Record<string, unknown>> {
  return [
    {
      fragment: "B002",
      status: "confirmed",
      candidateIds: [5, 4],
    },
    {
      fragment: "B003",
      status: "confirmed",
      candidateIds: [6, 7, 9, 8],
    },
  ];
}
