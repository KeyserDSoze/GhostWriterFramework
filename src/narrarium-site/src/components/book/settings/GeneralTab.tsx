import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { McpServerSection } from "@/components/book/McpServerSection";
import type { BookEntry, ParagraphSeparator } from "@/types/settings";
import type { BookPresentation } from "@/bookSettings/draft";

interface Props {
  book: BookEntry;
  name: string;
  onName: (name: string) => void;
  presentation: BookPresentation;
  onPresentation: (change: (current: BookPresentation) => BookPresentation) => void;
}

/** What is not about GitHub, the export or the audit: the name in the library, how the reader and the exported files present the book's metadata, and the book's MCP server. */
export function GeneralTab({ book, name, onName, presentation, onPresentation: patchPresentation }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("bookSettings.general")}</CardTitle>
          <CardDescription>{t("bookSettings.generalDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="book-name">{t("bookSettings.name")}</Label>
            <Input id="book-name" value={name} onChange={(event) => onName(event.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("bookSettings.metadataPresentation")}</CardTitle>
          <CardDescription>{t("bookSettings.metadataPresentationDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <MetadataFieldInput label={t("bookSettings.bookMetadataFields")} value={presentation.metadataVisibility.book} onChange={(value) => patchPresentation((current) => ({ ...current, metadataVisibility: { ...current.metadataVisibility, book: value } }))} placeholder="title, author, date" />
          <MetadataFieldInput label={t("bookSettings.chapterMetadataFields")} value={presentation.metadataVisibility.chapter} onChange={(value) => patchPresentation((current) => ({ ...current, metadataVisibility: { ...current.metadataVisibility, chapter: value } }))} placeholder="title, date, summary" />
          <MetadataFieldInput label={t("bookSettings.paragraphMetadataFields")} value={presentation.metadataVisibility.paragraph} onChange={(value) => patchPresentation((current) => ({ ...current, metadataVisibility: { ...current.metadataVisibility, paragraph: value } }))} placeholder="title, date" />
          <div className="grid gap-2 sm:max-w-sm">
            <Label htmlFor="paragraph-separator">{t("bookSettings.paragraphSeparator")}</Label>
            <Select value={presentation.paragraphSeparator} onValueChange={(value) => patchPresentation((current) => ({ ...current, paragraphSeparator: value as ParagraphSeparator }))}>
              <SelectTrigger id="paragraph-separator"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("bookSettings.separatorNone")}</SelectItem>
                <SelectItem value="star">{t("bookSettings.separatorStar")}</SelectItem>
                <SelectItem value="asterisks">{t("bookSettings.separatorAsterisks")}</SelectItem>
                <SelectItem value="custom">{t("bookSettings.separatorCustom")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {presentation.paragraphSeparator === "custom" && <Input aria-label={t("bookSettings.separatorCustom")} value={presentation.customParagraphSeparator} onChange={(event) => patchPresentation((current) => ({ ...current, customParagraphSeparator: event.target.value }))} placeholder={t("bookSettings.customSeparatorPlaceholder")} className="sm:max-w-sm" />}
          <p className="text-xs text-muted-foreground">{t("bookSettings.metadataPresentationHint")}</p>
        </CardContent>
      </Card>

      <McpServerSection book={book} />
    </>
  );
}

function MetadataFieldInput({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (value: string[]) => void; placeholder: string }) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value.join(", ")} onChange={(event) => onChange(event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean))} placeholder={placeholder} />
    </div>
  );
}
