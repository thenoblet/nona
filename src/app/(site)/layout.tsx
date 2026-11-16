import { Suspense } from "react";
import { connection } from "next/server";
import { Dock } from "@/components/music/Dock";
import { TabBar, TabBarFrame } from "@/components/nav/TabBar";
import { modeAt, previewAllowed } from "@/lib/mode";

/** Which tabs the bar shows depends on today's date, so it is worked out per request. */
async function TabBarNow() {
  await connection();
  return <TabBar mode={modeAt(new Date())} previewAllowed={previewAllowed} />;
}

/** Pages that share the floating music player and, on phones, the tab bar. */
export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {children}
      <Dock />
      <Suspense fallback={<TabBarFrame />}>
        <TabBarNow />
      </Suspense>
    </>
  );
}
