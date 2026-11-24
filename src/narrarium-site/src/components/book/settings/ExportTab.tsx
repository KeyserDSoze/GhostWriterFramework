import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BookExportSettingsFields } from "@/components/book/BookExportSettingsFields";
import type { BookEntry } from "@/types/settings";
import type { ExportDraft } from "@/bookSettings/exportDraft";
import type { BookPresentation } from "@/bookSettings/draft";

interface Props {
  book: BookEntry;
  draft: ExportDraft;
  onChange: (draft: ExportDraft) => void;
  presentation: BookPresentation;
}

/** The export presets (typography, what the file holds, where it goes). They are the same settings as the dialog of the export page, saved with the rest of the book's settings. */
export function ExportTab({ book, draft, onChange, presentation }: Props) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("export.settingsTitle")}</CardTitle>
        <CardDescription>{t("export.settingsDescription")}</CardDescription>
        <CardDescription>{t("bookSettings.tabs.exportHelp")}</CardDescription>
      </CardHeader>
      <CardContent>
        <BookExportSettingsFields draft={draft} onChange={onChange} book={book} keep={presentation} />
      </CardContent>
    </Card>
  );
}
