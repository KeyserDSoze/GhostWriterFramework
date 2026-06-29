import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCostsStore, aggregateAll, bucketTotal } from "@/costs/costsStore";
import { emptyBucket, type UsageBucket } from "@/costs/model";

function eur(value: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 4 }).format(value || 0);
}

function num(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value || 0));
}

function hours(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value || 0);
}

export function CostsPage() {
  const { t } = useTranslation();
  const file = useCostsStore((s) => s.file);
  const total = useMemo(() => aggregateAll(file), [file]);
  const books = useMemo(() => Object.values(file.books).map((b) => ({ ...emptyBucket(), ...b })).sort((a, b) => bucketTotal(b) - bucketTotal(a)), [file]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><Coins className="h-5 w-5" />{t("costs.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("costs.intro")}</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("costs.grandTotal")}</CardTitle></CardHeader>
        <CardContent>
          <CategoryGrid bucket={total} />
          <p className="mt-3 text-right text-xl font-semibold">{eur(bucketTotal(total))}</p>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.perBook")}</h2>
        {books.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("costs.empty")}</p>
        ) : (
          <div className="space-y-3">
            {books.map((book) => (
              <Card key={book.bookId}>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle className="text-base">{book.bookName || book.bookId}</CardTitle>
                  <span className="text-lg font-semibold">{eur(bucketTotal(book))}</span>
                </CardHeader>
                <CardContent><CategoryGrid bucket={book} /></CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryGrid({ bucket }: { bucket: UsageBucket }) {
  const { t } = useTranslation();
  const imageTokens = bucket.imageInputTextTokens + bucket.imageInputImageTokens + bucket.imageOutputTokens;
  const imageDetail = imageTokens > 0
    ? `${num(bucket.imageCount)} ${t("costs.imagesUnit")} · ${num(bucket.imageInputTextTokens)} txt · ${num(bucket.imageInputImageTokens)} img-in · ${num(bucket.imageOutputTokens)} img-out`
    : `${num(bucket.imageCount)} ${t("costs.imagesUnit")}`;
  const rows = [
    { label: t("costs.chat"), cost: bucket.chatCost, detail: `${num(bucket.inputTokens)} in · ${num(bucket.cachedTokens)} cache · ${num(bucket.outputTokens)} out` },
    { label: t("costs.images"), cost: bucket.imageCost, detail: imageDetail },
    { label: t("costs.tts"), cost: bucket.ttsCost, detail: `${num(bucket.ttsChars)} ${t("costs.charsUnit")}` },
    { label: t("costs.stt"), cost: bucket.sttCost, detail: `${hours(bucket.sttHours)} ${t("costs.hourUnit")}` },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2">
          <div>
            <p className="text-sm font-medium">{row.label}</p>
            <p className="text-[11px] text-muted-foreground">{row.detail}</p>
          </div>
          <span className="text-sm font-semibold">{eur(row.cost)}</span>
        </div>
      ))}
    </div>
  );
}
