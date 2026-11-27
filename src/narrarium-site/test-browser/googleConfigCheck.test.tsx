import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { GoogleConfigCheck } from "@/components/account/GoogleConfigCheck";
import { googleConfigReport, googleProjectNumber } from "@/account/googleConfigCheck";
import { GOOGLE_CLIENT_ID } from "@/config/publicClients";
import { googleSignInScopeList, includesRestrictedGoogleScope } from "@/config/googleAuth";

describe("what the check of the Google configuration reports", () => {
  it("reads the project number of a client id and never the rest of it", () => {
    expect(googleProjectNumber("91477716497-k7n97b2q9ic3nc75jpjmb0d3f73s1vgu.apps.googleusercontent.com")).toBe("91477716497");
    expect(googleProjectNumber("  123456-abc.apps.googleusercontent.com ")).toBe("123456");
    for (const other of ["", "not-a-client-id", "91477716497", "k7n-91477716497.apps.googleusercontent.com", "12-abc.apps.googleusercontent.com"]) expect(googleProjectNumber(other)).toBeNull();
  });

  it("lists exactly what a sign-in asks for, and nothing restricted", () => {
    const report = googleConfigReport(GOOGLE_CLIENT_ID);
    expect(report.scopes).toEqual(["openid", "profile", "email", "https://www.googleapis.com/auth/drive.appdata", "https://www.googleapis.com/auth/drive.file"]);
    expect(report.scopes).toEqual(googleSignInScopeList());
    expect(includesRestrictedGoogleScope(report.scopes)).toBe(false);
    expect(report.project).toMatch(/^\d{6,}$/);
  });
});

afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

describe.each(["en", "it"] as const)("Check Google configuration in %s", (language) => {
  const text = language === "en"
    ? { title: "Check Google configuration", scopes: "Permissions asked at every sign-in", appdata: /drive\.appdata — a hidden app folder \(non-sensitive\)/, file: /drive\.file — the files and folders Narrarium creates \(non-sensitive\)/, notAsked: /Never asked at sign-in: full access to Drive/, project: /^Project number \d+ \(the rest of the id is not shown\)$/, audience: /Publishing status must be “In production”.*7 days/, grants: /myaccount\.google\.com\/connections/ }
    : { title: "Controlla la configurazione di Google", scopes: "Permessi chiesti a ogni accesso", appdata: /drive\.appdata — una cartella nascosta dell'app \(non sensibile\)/, file: /drive\.file — i file e le cartelle che Narrarium crea \(non sensibile\)/, notAsked: /Mai chiesto all'accesso: l'accesso completo a Drive/, project: /^Numero del progetto \d+ \(il resto dell'id non viene mostrato\)$/, audience: /«In produzione».*7 giorni/, grants: /myaccount\.google\.com\/connections/ };

  it("shows the permissions, the project number only, and the checklist for the owner of the project", async () => {
    await i18n.changeLanguage(language);
    render(<GoogleConfigCheck />);
    const check = screen.getByTestId("google-config-check");
    expect(within(check).getByRole("heading", { name: text.title })).toBeInTheDocument();
    expect(within(check).getByText(text.scopes)).toBeInTheDocument();
    const scopes = within(screen.getByTestId("google-config-scopes"));
    expect(scopes.getAllByRole("listitem")).toHaveLength(5);
    expect(scopes.getByText(text.appdata)).toBeInTheDocument();
    expect(scopes.getByText(text.file)).toBeInTheDocument();
    expect(within(check).getByText(text.notAsked)).toBeInTheDocument();
    expect(screen.getByTestId("google-config-client").textContent).toMatch(text.project);
    expect(within(check).getByText(text.audience)).toBeInTheDocument();
    expect(within(check).getByText(text.grants)).toBeInTheDocument();
  });

  it("never writes the client id (only its project number), a secret or the restricted scope", async () => {
    await i18n.changeLanguage(language);
    render(<GoogleConfigCheck />);
    const shown = document.body.textContent ?? "";
    expect(shown).not.toContain(GOOGLE_CLIENT_ID);
    expect(shown).not.toContain(GOOGLE_CLIENT_ID.split("-")[1]);
    expect(shown).not.toMatch(/apps\.googleusercontent\.com/);
    expect(shown).not.toMatch(/auth\/drive(?![.\w])/);
    expect(shown).not.toMatch(/GOCSPX|client_secret/i);
  });
});
