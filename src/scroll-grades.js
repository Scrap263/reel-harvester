export function popularityGrade(views) {
  if (views == null || views === "") return "unknown";
  if (!Number.isFinite(Number(views))) return "unknown";
  if (Number(views) >= 1_000_000) return "mega";
  if (Number(views) >= 500_000) return "viral";
  if (Number(views) >= 100_000) return "hot";
  return "normal";
}

export function engagementStats(likes, views) {
  const likesNumber = Number(likes);
  const viewsNumber = Number(views);
  if (!Number.isFinite(likesNumber) || !Number.isFinite(viewsNumber) || viewsNumber <= 0) {
    return { rate: null, grade: "unknown" };
  }
  const rate = likesNumber / viewsNumber;
  const grade = rate >= 0.1 ? "elite" : rate >= 0.05 ? "high" : rate >= 0.02 ? "medium" : "low";
  return { rate, grade };
}

export function recencyGrade(publishedAt, now = Date.now()) {
  const timestamp = new Date(publishedAt).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const age = Math.max(0, now - timestamp);
  if (age <= 86_400_000) return "today";
  if (age <= 7 * 86_400_000) return "fresh";
  if (age <= 30 * 86_400_000) return "recent";
  return "older";
}

export function scrollGrades(reel, now = Date.now()) {
  const engagement = engagementStats(reel.likes, reel.views);
  return {
    popularityGrade: popularityGrade(reel.views),
    engagementRate: engagement.rate,
    engagementGrade: engagement.grade,
    recencyGrade: recencyGrade(reel.publishedAt ?? reel.published_at, now)
  };
}
