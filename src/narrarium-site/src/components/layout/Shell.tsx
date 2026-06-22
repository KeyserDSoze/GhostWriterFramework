import { Outlet } from "react-router-dom";
import { useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { DossierDock } from "./DossierDock";
import { useSettings } from "@/drive/useSettings";

export function Shell() {
  const { load } = useSettings();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
      <DossierDock />
    </div>
  );
}
