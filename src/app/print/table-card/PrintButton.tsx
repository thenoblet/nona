"use client";

import { PillButton } from "@/components/ui/Button";

export function PrintButton() {
  return (
    <PillButton variant="cocoa" onClick={() => window.print()}>
      Print this card
    </PillButton>
  );
}
