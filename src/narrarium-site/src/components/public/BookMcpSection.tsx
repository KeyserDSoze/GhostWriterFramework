import { Fragment, useId } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { mcpBookTools, type BookToolEntry, type BookToolPermission } from "@/lib/generated-mcp-book-tools";
import { cn } from "@/lib/utils";

const PERMISSIONS: readonly BookToolPermission[] = ["read", "write", "run"];

type Note = "readOnly" | "destructive" | "additive";

/** What a tool does to the book, said from its own annotations: it only reads, it can replace or remove what is there, or it does not overwrite anything. */
const noteOf = (tool: BookToolEntry): Note => (tool.annotations.readOnlyHint ? "readOnly" : tool.annotations.destructiveHint ? "destructive" : "additive");

/** The label never relies on its colour: the words say it, the colour only helps the eye. */
const NOTE_STYLE: Record<Note, string> = {
  readOnly: "",
  destructive: "border-destructive/50 text-destructive",
  additive: "font-medium text-muted-foreground",
};

const linkClass = "inline-flex min-h-11 items-center text-primary underline underline-offset-4 hover:text-primary/80";

/**
 * The part of the public /mcp page about the MCP of a book on a personal server: what it is for, how to switch it on, the three permissions, how an app
 * connects, the one-sentence risk, and the real list of the tools in a table for each permission. The list is generated from the server's own registry
 * (`packages/server/mcp-tools.json`), and the page that renders this component is the only thing that loads it.
 */
export function BookMcpSection() {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <section id="book" tabIndex={-1} aria-labelledby={titleId} className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 pb-12 focus:outline-none sm:px-6 lg:px-8">
      <h2 id={titleId} className="font-serif text-3xl font-semibold tracking-tight">{t("mcpBookPage.title")}</h2>
      <p className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">{t("mcpBookPage.lead")}</p>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-xl">{t("mcpBookPage.use.title")}</CardTitle></CardHeader>
          <CardContent><p className="text-sm leading-6">{t("mcpBookPage.use.body")}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-xl">{t("mcpBookPage.start.title")}</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm leading-6">{t("mcpBookPage.start.body")}</p>
            <ul className="mt-3 space-y-1 text-sm">
              <li><Link className={linkClass} to="/docs/book-mcp">{t("mcpBookPage.start.guide")}</Link></li>
              <li><Link className={linkClass} to="/docs/server#mcp-for-each-book">{t("mcpBookPage.start.server")}</Link></li>
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-xl">{t("mcpBookPage.permissions.title")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm leading-6">
              {PERMISSIONS.map((permission) => (
                <div key={permission}>
                  <dt className="font-medium">{t(`mcpBookPage.permissions.${permission}.name`)}</dt>
                  <dd className="text-muted-foreground">{t(`mcpBookPage.permissions.${permission}.text`)}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-xl">{t("mcpBookPage.access.title")}</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
              <li>{t("mcpBookPage.access.oauth")}</li>
              <li>{t("mcpBookPage.access.readOnly")}</li>
              <li>{t("mcpBookPage.access.revoke")}</li>
              <li>{t("mcpBookPage.access.token")}</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <p role="note" className="mt-4 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span><strong>{t("mcpBookPage.risk.label")}</strong> {t("mcpBookPage.risk.text")}</span>
      </p>

      <p className="mt-8 max-w-3xl text-sm leading-6 text-muted-foreground">{t("mcpBookPage.tools.intro")}</p>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">{t("mcpBookPage.tools.legend")}</p>
      <div className="mt-4 grid grid-cols-1 gap-6">
        {PERMISSIONS.map((permission) => <BookToolTable key={permission} permission={permission} tools={mcpBookTools.filter((tool) => tool.permission === permission)} />)}
      </div>
    </section>
  );
}

function BookToolTable({ permission, tools }: { permission: BookToolPermission; tools: BookToolEntry[] }) {
  const { t } = useTranslation();
  const titleId = useId();
  return (
    <Card>
      <CardHeader className="p-4 sm:p-6">
        <CardTitle id={titleId}>{t(`mcpBookPage.permissions.${permission}.name`)}</CardTitle>
        <CardDescription>{tools.length} {tools.length === 1 ? t("mcpPageContent.toolSingle") : t("mcpPageContent.toolPlural")} · {t(`mcpBookPage.tables.${permission}`)}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-4 pt-0 sm:p-6 sm:pt-0">
        <table aria-labelledby={titleId} className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th scope="col" className="border-b py-2 pr-4 sm:w-48">{t("mcpPageContent.tool")}</th><th scope="col" className="border-b py-2">{t("mcpPageContent.description")}</th></tr>
          </thead>
          <tbody>{tools.map((tool) => <BookToolRow key={tool.name} tool={tool} />)}</tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function BookToolRow({ tool }: { tool: BookToolEntry }) {
  const { t } = useTranslation();
  const note = noteOf(tool);
  return (
    <tr data-tool={tool.name}>
      <th scope="row" className="whitespace-nowrap border-b py-3 pr-4 text-left align-top font-mono text-xs font-normal text-primary">{tool.name}</th>
      <td className="border-b py-3 align-top">
        <div className="flex flex-col items-start gap-2 lg:flex-row lg:justify-between lg:gap-6">
          <div className="min-w-0 space-y-1">
            <p className="text-muted-foreground">{t(`mcpBookTools.${tool.name}`, { defaultValue: tool.title })}</p>
            {tool.parameters.length > 0 && (
              <p className="text-xs text-muted-foreground">
                <span>{t("mcpBookPage.takes.label")}:</span>{" "}
                {tool.parameters.map((parameter, index) => (
                  <Fragment key={parameter.name}>
                    {index > 0 && ", "}
                    <span data-parameter={parameter.name} data-required={String(parameter.required)}>
                      <code className="font-mono">{parameter.name}</code>
                      {parameter.required && <><span aria-hidden="true">*</span><span className="sr-only"> ({t("mcpBookPage.takes.required")})</span></>}
                    </span>
                  </Fragment>
                ))}
              </p>
            )}
          </div>
          <Badge variant="outline" data-note={note} className={cn("max-w-full shrink-0 rounded-xl text-left lg:whitespace-nowrap", NOTE_STYLE[note])}>{t(`mcpBookPage.notes.${note}`)}</Badge>
        </div>
      </td>
    </tr>
  );
}
