export function withBase(pathname: string): string {
  const base = import.meta.env.BASE_URL;
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const normalizedPath = pathname.replace(/^\/+/, "");
  return normalizedPath ? `${normalizedBase}${normalizedPath}` : normalizedBase;
}
