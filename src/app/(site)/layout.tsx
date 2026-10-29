import { Dock } from "@/components/music/Dock";

/** Pages that share the floating music player. */
export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      {children}
      <Dock />
    </>
  );
}
