"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SlotView } from "@/lib/site-images/admin";
import type { SlotGroupId } from "@/lib/site-images/slots";
import { setUnsavedChanges } from "@/components/admin/content/unsaved";
import { SlotCard } from "./SlotCard";

type Group = { id: SlotGroupId; name: string; note?: string; slots: SlotView[] };

/**
 * The Site photos page (gate B): the groups listed down the side (a menu above the slots on a
 * phone), each group's slots under its heading. A slot with unsaved changes makes the admin's tabs
 * ask before leaving, as Site text does.
 */
export function SitePhotosEditor({ groups }: { groups: Group[] }) {
  const [current, setCurrent] = useState<SlotGroupId>(groups[0]?.id ?? "landing");
  const dirtySlots = useRef(new Set<string>());

  const onDirtyChange = useCallback((slotId: string, dirty: boolean) => {
    if (dirty) dirtySlots.current.add(slotId);
    else dirtySlots.current.delete(slotId);
    setUnsavedChanges(dirtySlots.current.size > 0);
  }, []);

  useEffect(() => () => setUnsavedChanges(false), []);

  function jumpTo(groupId: SlotGroupId) {
    setCurrent(groupId);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`group-${groupId}`)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }

  return (
    <div className="admin-photos-editor">
      <nav className="admin-sectionnav" aria-label="Groups">
        {groups.map((group) => (
          <a
            key={group.id}
            href={`#group-${group.id}`}
            className="admin-sectionnav-count"
            aria-current={current === group.id ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              jumpTo(group.id);
            }}
          >
            {group.name}
            <span>{group.slots.length}</span>
          </a>
        ))}
      </nav>
      <div>
        <div className="admin-sectionpick">
          <label htmlFor="slot-pick">Jump to</label>
          <select id="slot-pick" value={current} onChange={(event) => jumpTo(event.target.value as SlotGroupId)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name} ({group.slots.length})
              </option>
            ))}
          </select>
        </div>
        {groups.map((group) => (
          <section key={group.id} className="admin-group" id={`group-${group.id}`} aria-labelledby={`group-title-${group.id}`}>
            <div className="admin-group-head">
              <h2 id={`group-title-${group.id}`}>{group.name}</h2>
              {group.note ? <p>{group.note}</p> : null}
            </div>
            <div className="admin-slots">
              {group.slots.map((slot) => (
                <SlotCard key={slot.id} initial={slot} onDirtyChange={onDirtyChange} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
