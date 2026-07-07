import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Loader2, Plus, Save, Trash2, Wand2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { createBlankCustomAction, customActionCapabilities, supportedCustomActionTargetTypes, ALL_TARGET_TYPES } from "@/custom-actions/customActions";
import { useSettings } from "@/drive/useSettings";
import { useRegisterPageSave } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { ChatCapability, CustomAction, CustomActionActivation, CustomActionOutputMode } from "@/types/settings";

export function CustomActionsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, load, syncStatus } = useSettings();
  const didLoad = useRef(false);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(settings.customActions ?? []));
  const actions = settings.customActions ?? [];
  const dirty = JSON.stringify(actions) !== savedSnapshot;
  const saving = syncStatus === "saving";

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void load().then(() => setSavedSnapshot(JSON.stringify(useSettingsStore.getState().settings.customActions ?? [])));
  }, [load]);

  useRegisterPageSave({ dirty, enabled: true, onSave: () => handleSave() });

  function patchActions(next: CustomAction[]) {
    patchSettings({ customActions: next });
  }

  function addAction() {
    const next = createBlankCustomAction();
    next.name = t("customActions.newActionName");
    patchActions([...actions, next]);
  }

  function updateAction(id: string, patch: Partial<CustomAction>) {
    patchActions(actions.map((action) => action.id === id ? { ...action, ...patch } : action));
  }

  function removeAction(id: string) {
    patchActions(actions.filter((action) => action.id !== id));
  }

  function moveAction(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    patchActions(next);
  }

  async function handleSave() {
    await save();
    setSavedSnapshot(JSON.stringify(useSettingsStore.getState().settings.customActions ?? []));
    toast({ title: t("customActions.saved") });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Wand2 className="h-6 w-6" />{t("customActions.title")}</h1>
          <p className="text-muted-foreground">{t("customActions.description")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={addAction}><Plus className="mr-1 h-4 w-4" />{t("customActions.add")}</Button>
          <Button onClick={() => void handleSave()} disabled={saving || !dirty}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
        </div>
      </div>

      {actions.length === 0 ? (
        <Card className="border-dashed">
          <CardHeader>
            <CardTitle>{t("customActions.emptyTitle")}</CardTitle>
            <CardDescription>{t("customActions.emptyDescription")}</CardDescription>
          </CardHeader>
          <CardContent><Button onClick={addAction}><Plus className="mr-1 h-4 w-4" />{t("customActions.add")}</Button></CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {actions.map((action, index) => (
            <CustomActionCard
              key={action.id}
              action={action}
              index={index}
              isFirst={index === 0}
              isLast={index === actions.length - 1}
              onMove={moveAction}
              onRemove={removeAction}
              onUpdate={updateAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CustomActionCard({ action, index, isFirst, isLast, onMove, onRemove, onUpdate }: {
  action: CustomAction;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<CustomAction>) => void;
}) {
  const { t } = useTranslation();
  const targetTypes = useMemo(() => supportedCustomActionTargetTypes(), []);
  const capabilities = useMemo(() => customActionCapabilities(), []);
  const allTargets = action.targetTypes.includes(ALL_TARGET_TYPES);
  const patchInjections = (patch: Partial<CustomAction["injections"]>) => onUpdate(action.id, { injections: { ...action.injections, ...patch } });

  function toggleTarget(value: string) {
    if (value === ALL_TARGET_TYPES) {
      onUpdate(action.id, { targetTypes: [ALL_TARGET_TYPES] });
      return;
    }
    const current = action.targetTypes.filter((entry) => entry !== ALL_TARGET_TYPES);
    const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
    onUpdate(action.id, { targetTypes: next.length ? next : [ALL_TARGET_TYPES] });
  }

  return (
    <Card className={!action.enabled ? "opacity-70" : undefined}>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-xl">
            <span className="truncate">{action.name || t("customActions.unnamed")}</span>
            <Badge variant={action.enabled ? "default" : "secondary"}>{action.enabled ? t("customActions.enabled") : t("customActions.disabled")}</Badge>
          </CardTitle>
          <CardDescription>{t("customActions.cardDescription")}</CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" disabled={isFirst} onClick={() => onMove(index, -1)} aria-label={t("customActions.moveUp")}><ArrowUp className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" disabled={isLast} onClick={() => onMove(index, 1)} aria-label={t("customActions.moveDown")}><ArrowDown className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={() => onRemove(action.id)} aria-label={t("customActions.delete")}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">{t("customActions.enabled")}</p>
            <p className="text-xs text-muted-foreground">{t("customActions.enabledHint")}</p>
          </div>
          <Switch checked={action.enabled} onCheckedChange={(enabled) => onUpdate(action.id, { enabled })} />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-2">
            <Label>{t("customActions.name")}</Label>
            <Input value={action.name} onChange={(event) => onUpdate(action.id, { name: event.target.value })} placeholder={t("customActions.namePlaceholder")} />
          </div>
          <div className="grid gap-2">
            <Label>{t("customActions.capability")}</Label>
            <Select value={action.capability} onValueChange={(capability) => onUpdate(action.id, { capability: capability as ChatCapability })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{capabilities.map((capability) => <SelectItem key={capability} value={capability}>{t(`routing.task.${capability}`)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-2">
          <Label>{t("customActions.prompt")}</Label>
          <Textarea value={action.prompt} onChange={(event) => onUpdate(action.id, { prompt: event.target.value })} placeholder={t("customActions.promptPlaceholder")} className="min-h-32" />
        </div>

        <Separator />

        <section className="space-y-3">
          <div>
            <p className="text-sm font-semibold">{t("customActions.contextAvailability")}</p>
            <p className="text-xs text-muted-foreground">{t("customActions.contextAvailabilityHint")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <TargetChip active={allTargets} label={t("customActions.targets.all")} onClick={() => toggleTarget(ALL_TARGET_TYPES)} />
            {targetTypes.map((target) => (
              <TargetChip key={target.value} active={!allTargets && action.targetTypes.includes(target.value)} label={t(target.labelKey)} onClick={() => toggleTarget(target.value)} />
            ))}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="grid gap-2">
            <Label>{t("customActions.activation")}</Label>
            <Select value={action.activation} onValueChange={(activation) => onUpdate(action.id, { activation: activation as CustomActionActivation })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="selection">{t("customActions.activationSelection")}</SelectItem>
                <SelectItem value="element">{t("customActions.activationElement")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>{t("customActions.outputMode")}</Label>
            <Select value={action.outputMode} onValueChange={(outputMode) => onUpdate(action.id, { outputMode: outputMode as CustomActionOutputMode })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="show">{t("customActions.outputShow")}</SelectItem>
                <SelectItem value="replace">{t("customActions.outputReplace")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Separator />

        <section className="space-y-3">
          <div>
            <p className="text-sm font-semibold">{t("customActions.injections")}</p>
            <p className="text-xs text-muted-foreground">{t("customActions.injectionsHint")}</p>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <InjectionSwitch label={t("customActions.includeBody")} checked={action.injections.includeBody} onChange={(includeBody) => patchInjections({ includeBody })} />
            <InjectionSwitch label={t("customActions.includeFrontmatter")} checked={action.injections.includeFrontmatter} onChange={(includeFrontmatter) => patchInjections({ includeFrontmatter })} />
            <InjectionSwitch label={t("customActions.includeContext")} checked={action.injections.includeContext} onChange={(includeContext) => patchInjections({ includeContext })} />
            <InjectionSwitch label={t("customActions.includeWritingStyle")} checked={action.injections.includeWritingStyle} onChange={(includeWritingStyle) => patchInjections({ includeWritingStyle })} />
            <InjectionSwitch label={t("customActions.includeGhostwriter")} checked={action.injections.includeGhostwriter} onChange={(includeGhostwriter) => patchInjections({ includeGhostwriter })} />
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function TargetChip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <Button type="button" size="sm" variant={active ? "default" : "outline"} onClick={onClick}>{label}</Button>;
}

function InjectionSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <span className="text-sm font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
