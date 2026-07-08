import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCostsStore, aggregateAll, bucketTotal } from "@/costs/costsStore";
import { useSettingsStore } from "@/store/settingsStore";
import { emptyBucket, type UsageBucket } from "@/costs/model";

function formatCost(value: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.trim() || "USD", maximumFractionDigits: 4 }).format(value || 0);
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
  const { settings } = useSettingsStore();
  const currency = settings.costCurrency || "USD";
  const total = useMemo(() => aggregateAll(file), [file]);
  const books = useMemo(() => Object.values(file.books).map((b) => ({ ...emptyBucket(), ...b })).sort((a, b) => bucketTotal(b) - bucketTotal(a)), [file]);
  const fmt = (v: number) => formatCost(v, currency);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold"><Coins className="h-5 w-5" />{t("costs.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("costs.intro")} <span className="font-mono text-xs text-muted-foreground">({currency})</span></p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("costs.grandTotal")}</CardTitle></CardHeader>
        <CardContent>
          <CategoryGrid bucket={total} fmt={fmt} />
          <p className="mt-3 text-right text-xl font-semibold">{fmt(bucketTotal(total))}</p>
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
                  <span className="text-lg font-semibold">{fmt(bucketTotal(book))}</span>
                </CardHeader>
                <CardContent>
                  <CategoryGrid bucket={book} fmt={fmt} />
                  <ModelBreakdown models={book.models} fmt={fmt} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ModelBreakdown({ models, fmt }: { models?: Record<string, UsageBucket>; fmt: (v: number) => string }) {
  const { t } = useTranslation();
  const entries = useMemo(
    () => Object.entries(models ?? {})
      .map(([name, bucket]) => [name, { ...emptyBucket(), ...bucket }] as const)
      .filter(([, bucket]) => bucket.chatCost > 0 || bucket.inputTokens > 0 || bucket.outputTokens > 0)
      .sort((a, b) => b[1].chatCost - a[1].chatCost),
    [models],
  );
  if (entries.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("costs.perModel")}</p>
      <div className="space-y-1.5">
        {entries.map(([name, bucket]) => (
          <div key={name} className="flex items-center justify-between rounded-lg border bg-muted/10 px-3 py-1.5">
            <div>
              <p className="text-sm font-medium">{name}</p>
              <p className="text-[11px] text-muted-foreground">{`${num(bucket.inputTokens)} in · ${num(bucket.cachedTokens)} cache · ${num(bucket.outputTokens)} out`}</p>
            </div>
            <span className="text-sm font-semibold">{fmt(bucket.chatCost)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryGrid({ bucket, fmt }: { bucket: UsageBucket; fmt: (v: number) => string }) {
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
          <span className="text-sm font-semibold">{fmt(row.cost)}</span>
        </div>
      ))}
    </div>
  );
}
