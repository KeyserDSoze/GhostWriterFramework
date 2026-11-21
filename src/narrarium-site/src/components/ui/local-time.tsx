import { useTranslation } from "react-i18next";
import { formatLocalDateTime, isReadableInstant } from "@/lib/formatDateTime";

/** An ISO instant shown in the viewer's time zone and the app language; the exact value stays in the tooltip. */
export function LocalTime({ value, className }: { value: string; className?: string }) {
  const { i18n } = useTranslation();
  if (!isReadableInstant(value)) return <span className={className}>{value}</span>;
  return <time dateTime={value} title={value} className={className}>{formatLocalDateTime(value, i18n.resolvedLanguage ?? i18n.language)}</time>;
}
