"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { restoreVersionAction, saveSectionAction } from "@/app/admin/content/actions";
import {
  EDITOR_FIELDS,
  MAX_SECTION_BYTES,
  parseIssues,
  TOO_LONG,
  type ContentSectionKey,
  type SaveState,
} from "@/lib/admin/content";
import { getAt, insertAt, moveItem, pathKey, removeAt, setAt, type Path } from "./editing";
import {
  fieldsFor,
  fieldsInOrder,
  sectionSpecs,
  type EditorContext,
  type FieldSpec,
  type ListSpec,
  type SectionSpec,
} from "./fields";
import { setUnsavedChanges } from "./unsaved";
import { VersionHistory, type RestoreNotice, type VersionEntry } from "./VersionHistory";

const NOT_SAVED = "That didn't save. Check the connection, reload the page and try again.";

/** What the last save said is wrong: fields by path, problems with the section as a whole, and any other message. */
type Problems = { fields: Map<string, string>; general: string[]; message: string | null };
const noProblems: Problems = { fields: new Map(), general: [], message: null };

/** After a render, focus moves here: a list item's control, or the first problem after a failed save. */
type FocusTarget = { item: string; control: "first" | "group" | "up" | "down" } | { add: true } | { problems: true };

function problemsFrom(sectionKey: ContentSectionKey, spec: SectionSpec, value: unknown, errors: string[]): Problems {
  const shown = new Set(fieldsInOrder(spec, value).map((field) => field.path));
  const problems: Problems = { fields: new Map(), general: [], message: null };
  for (const issue of parseIssues(sectionKey, errors)) {
    if (issue.path === null) problems.message ??= issue.message;
    else if (shown.has(issue.path)) {
      if (!problems.fields.has(issue.path)) problems.fields.set(issue.path, issue.message);
    } else problems.general.push(issue.message);
  }
  return problems;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** React keys for a list's items, so moving one keeps its inputs; a section loaded afresh starts over. */
function keysFor(value: unknown): string[] {
  return listOf(value).map((_item, index) => `item-${index}`);
}

/**
 * The editor for one section. It holds the section's whole saved value and changes only the
 * fields the couple edit, so anything the form doesn't show (an FAQ topic, a party member's id,
 * a venue's coordinates) goes back exactly as it came. Saving posts it as JSON with the version
 * it was loaded from; after a save or a restore the page re-renders and the editor starts again
 * from the new version.
 */
export function ContentEditor({
  sectionKey,
  label,
  value,
  version,
  versions,
  context,
}: {
  sectionKey: ContentSectionKey;
  label: string;
  value: unknown;
  version: number;
  versions: VersionEntry[];
  context: EditorContext;
}) {
  const spec = sectionSpecs[sectionKey];
  const formId = useId();
  const [loaded, setLoaded] = useState({ version, value });
  const [draft, setDraft] = useState<unknown>(value);
  const [itemKeys, setItemKeys] = useState(() => keysFor(value));
  const [problems, setProblems] = useState<Problems>(noProblems);
  const [lastSave, setLastSave] = useState<SaveState>({ status: "idle", errors: [] });
  const [saving, startSaving] = useTransition();
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoreNotice, setRestoreNotice] = useState<RestoreNotice>({ text: "", tone: "ok", serial: 0 });
  const [restoring, startRestoring] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const nextItemKey = useRef(0);
  const focusTarget = useRef<FocusTarget | null>(null);

  // A new version arrived (this save, a restore, or a reload after someone else's): start from it.
  if (loaded.version !== version) {
    setLoaded({ version, value });
    setDraft(value);
    setItemKeys(keysFor(value));
  }

  const serialized = useMemo(() => JSON.stringify(draft), [draft]);
  const loadedSerialized = useMemo(() => JSON.stringify(loaded.value), [loaded.value]);
  const dirty = serialized !== loadedSerialized;
  const fieldNames = useMemo(() => fieldsInOrder(spec, draft), [spec, draft]);

  // Unsaved edits: the section links and menu ask before leaving, and the browser warns on close or reload.
  useEffect(() => {
    setUnsavedChanges(dirty);
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
      setUnsavedChanges(false);
    };
  }, [dirty]);

  useEffect(() => {
    const target = focusTarget.current;
    const form = formRef.current;
    if (!target || !form) return;
    focusTarget.current = null;
    let element: HTMLElement | null = null;
    if ("problems" in target) {
      element = form.querySelector<HTMLElement>('[aria-invalid="true"], .admin-form-problems');
    } else if ("add" in target) {
      element = form.querySelector<HTMLElement>("[data-add]");
    } else {
      const fieldset = form.querySelector<HTMLElement>(`[data-item="${target.item}"]`);
      if (target.control === "first") element = fieldset?.querySelector("input, textarea, select") ?? null;
      else if (target.control === "group") element = fieldset;
      else {
        // At the top or bottom the button pressed is now disabled, so focus its partner.
        const pressed = fieldset?.querySelector<HTMLButtonElement>(`[data-move="${target.control}"]`);
        element = pressed && !pressed.disabled ? pressed : (fieldset?.querySelector("[data-move]:not(:disabled)") ?? null);
      }
    }
    element?.focus();
  });

  function change(path: Path, next: unknown) {
    setDraft((current: unknown) => setAt(current, path, next));
    const key = pathKey(path);
    setProblems((current) => {
      if (!current.fields.has(key)) return current;
      const fields = new Map(current.fields);
      fields.delete(key);
      return { ...current, fields };
    });
  }

  // Moving items shifts every path after them, so field messages no longer fit and are dropped.
  function changeList(edit: <TItem>(list: TItem[]) => TItem[], focus: FocusTarget) {
    focusTarget.current = focus;
    setDraft((current: unknown) => edit(listOf(current)));
    setItemKeys((current) => edit(current));
    setProblems((current) => ({ ...current, fields: new Map() }));
  }

  // A new item goes at the end, so no other path moves and field messages stay.
  function add(editable: NonNullable<ListSpec["editable"]>) {
    const key = `new-${nextItemKey.current++}`;
    focusTarget.current = { item: key, control: "first" };
    setDraft((current: unknown) => {
      const list = listOf(current);
      return insertAt(list, list.length, editable.newItem(list));
    });
    setItemKeys((current) => [...current, key]);
  }

  function discard() {
    setDraft(loaded.value);
    setItemKeys(keysFor(loaded.value));
    setProblems(noProblems);
    setLastSave({ status: "idle", errors: [] });
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (new TextEncoder().encode(serialized).length > MAX_SECTION_BYTES) {
      setProblems({ ...noProblems, message: TOO_LONG });
      return;
    }
    const form = new FormData(event.currentTarget);
    const submitted = draft;
    startSaving(async () => {
      let result: SaveState;
      try {
        result = await saveSectionAction(sectionKey, lastSave, form);
      } catch {
        result = { status: "error", errors: [NOT_SAVED] };
      }
      const found = result.status === "error" ? problemsFrom(sectionKey, spec, submitted, result.errors) : noProblems;
      if (found.fields.size > 0 || found.general.length > 0) focusTarget.current = { problems: true };
      setLastSave(result);
      setProblems(found);
    });
  }

  function restore(target: number) {
    startRestoring(async () => {
      let result: SaveState;
      try {
        // The version shown as live goes too, so a restore can't undo a save this page hasn't seen.
        result = await restoreVersionAction(sectionKey, target, version);
      } catch {
        result = { status: "error", errors: [NOT_SAVED] };
      }
      setConfirming(null);
      const restored = target === 0 ? "The built-in text" : `Version ${target}`;
      if (result.status === "saved") {
        setProblems(noProblems);
        setLastSave({ status: "idle", errors: [] });
      }
      setRestoreNotice((previous) => ({
        text: result.status === "saved" ? `${restored} is live again, as version ${result.version}.` : (result.errors[0] ?? NOT_SAVED),
        tone: result.status === "saved" ? "ok" : "bad",
        serial: previous.serial + 1,
      }));
    });
  }

  const problemCount = problems.fields.size + problems.general.length;
  const firstField = fieldNames.find((field) => problems.fields.has(field.path));
  let status: { text: string; tone: "bad" | "ok" | "muted" } = { text: "", tone: "muted" };
  if (problems.message) status = { text: problems.message, tone: "bad" };
  else if (problemCount > 0) {
    const first = problems.general[0] ?? firstField?.name ?? "";
    status = { text: `${problemCount} ${problemCount === 1 ? "problem" : "problems"} to fix: ${first}`, tone: "bad" };
  } else if (dirty) status = { text: "Unsaved changes", tone: "muted" };
  else if (lastSave.status === "saved") status = { text: "Saved. Guests see it now.", tone: "ok" };

  const fieldProps = (field: FieldSpec, item: unknown, path: Path, idBase: string) => ({
    field,
    item,
    path,
    id: `${idBase}-${field.path.join("-") || "value"}`,
    error: problems.fields.get(pathKey(path)),
    context,
    onChange: change,
  });

  const history = {
    versions,
    confirming,
    restoring,
    notice: restoreNotice,
    dirty,
    onAsk: setConfirming,
    onCancel: () => setConfirming(null),
    onRestore: restore,
  };

  return (
    <>
      <div className="admin-editor-main">
        <form ref={formRef} className="admin-form" onSubmit={save} aria-busy={saving} noValidate>
          <input type="hidden" name={EDITOR_FIELDS.value} value={serialized} />
          <input type="hidden" name={EDITOR_FIELDS.baseVersion} value={version} />
          {spec.hint && <p className="admin-section-hint">{spec.hint}</p>}
          {problems.general.length > 0 && (
            <div className="admin-form-problems" tabIndex={-1}>
              <ul>
                {problems.general.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          {spec.layout === "groups"
            ? spec.groups.map((group) => {
                const groupPath = group.key === null ? [] : [group.key];
                const groupValue = getAt(draft, groupPath);
                return (
                  <fieldset key={group.key ?? "section"} className="admin-fieldset">
                    <legend>{group.legend}</legend>
                    <div className="admin-fields">
                      {group.fields.map((field) => (
                        <Field
                          key={field.path.join(".")}
                          {...fieldProps(field, groupValue, [...groupPath, ...field.path], `${formId}-${group.key ?? "section"}`)}
                        />
                      ))}
                    </div>
                  </fieldset>
                );
              })
            : listOf(draft).map((item, index, items) => {
                const itemKey = itemKeys[index] ?? `item-${index}`;
                const legend = spec.legend(item, index);
                const note = spec.note?.(item);
                return (
                  <fieldset key={itemKey} className="admin-fieldset" data-item={itemKey} tabIndex={-1}>
                    <legend>{legend}</legend>
                    {note && <p className="admin-item-note">{note}</p>}
                    <div className="admin-fields">
                      {fieldsFor(spec, item).map((field) => (
                        <Field
                          key={field.path.join(".") || "value"}
                          {...fieldProps(field, item, [index, ...field.path], `${formId}-${itemKey}`)}
                        />
                      ))}
                    </div>
                    {spec.editable && (
                      <div className="admin-item-actions">
                        <button
                          type="button"
                          className="admin-btn admin-btn-small"
                          data-move="up"
                          disabled={index === 0}
                          aria-label={`Move ${legend} up`}
                          onClick={() => changeList((list) => moveItem(list, index, index - 1), { item: itemKey, control: "up" })}
                        >
                          Move up
                        </button>
                        <button
                          type="button"
                          className="admin-btn admin-btn-small"
                          data-move="down"
                          disabled={index === items.length - 1}
                          aria-label={`Move ${legend} down`}
                          onClick={() => changeList((list) => moveItem(list, index, index + 1), { item: itemKey, control: "down" })}
                        >
                          Move down
                        </button>
                        {(spec.editable.removable?.(item) ?? true) && (
                          <button
                            type="button"
                            className="admin-btn admin-btn-small admin-btn-remove"
                            aria-label={`Remove ${legend}`}
                            onClick={() => {
                              const neighbour = itemKeys[index + 1] ?? itemKeys[index - 1];
                              changeList(
                                (list) => removeAt(list, index),
                                neighbour ? { item: neighbour, control: "group" } : { add: true },
                              );
                            }}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </fieldset>
                );
              })}

          {spec.layout === "list" && spec.editable && (
            <button type="button" className="admin-btn admin-add" data-add onClick={() => add(spec.editable!)}>
              {spec.editable.addLabel}
            </button>
          )}

          <div className="admin-savebar">
            <span className={`admin-savestatus admin-savestatus-${status.tone}`} role="status">
              {status.text}
            </span>
            <div className="admin-savebar-actions">
              <button type="button" className="admin-btn" onClick={discard}>
                Discard changes
              </button>
              <button type="submit" className="admin-btn admin-btn-primary" aria-disabled={saving}>
                {saving ? "Saving…" : `Save ${label.toLowerCase()}`}
              </button>
            </div>
          </div>
        </form>

        <details className="admin-versions-mobile">
          <summary>Version history</summary>
          <VersionHistory {...history} />
        </details>
      </div>

      <aside className="admin-versions" aria-label="Version history">
        <h2>Version history</h2>
        <VersionHistory {...history} />
      </aside>
    </>
  );
}

// Times bring up a number pad with a decimal point (it has no colon key; the save reads "14.30" as
// 14:30). Coordinates keep the full keyboard: Ghana's longitudes are negative, and the iPhone's
// decimal pad has no minus key.
const inputKinds: Record<"time" | "date" | "decimal", InputHTMLAttributes<HTMLInputElement>> = {
  time: { type: "text", inputMode: "decimal", autoComplete: "off" },
  date: { type: "date" },
  decimal: { type: "text", inputMode: "text", autoComplete: "off" },
};

/** Line breaks (and the space around them) in a one-line box become a single space. */
const lineBreaks = /\s*[\r\n]+\s*/g;

// Names, titles and links are one line of text, but drawn as a box that wraps and grows, so a long
// place name or map link is never cut off on a phone. Enter doesn't add a line, and a pasted line
// break becomes a space. Links are plain text so "#map" is allowed.
const oneLineKinds: Record<"text" | "link", TextareaHTMLAttributes<HTMLTextAreaElement>> = {
  text: {},
  link: { inputMode: "url", autoComplete: "off", autoCapitalize: "none", spellCheck: false },
};

/**
 * A text box's ref. Where CSS can't size the box to its text, it is sized here after each change;
 * and when a change was rewritten (a pasted line break became a space), the caret goes back to
 * where it was rather than jumping to the end.
 */
function useTextBox(text: string) {
  const box = useRef<HTMLTextAreaElement>(null);
  const caretAfterChange = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const caret = caretAfterChange.current;
    caretAfterChange.current = null;
    if (caret !== null && document.activeElement === element) element.setSelectionRange(caret, caret);
    if (CSS.supports("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
  }, [text]);
  const keepCaretAt = (position: number) => {
    caretAfterChange.current = position;
  };
  return { box, keepCaretAt };
}

function Field({
  field,
  item,
  path,
  id,
  error,
  context,
  onChange,
}: {
  field: FieldSpec;
  item: unknown;
  path: Path;
  id: string;
  error: string | undefined;
  context: EditorContext;
  onChange: (path: Path, value: unknown) => void;
}) {
  const value = getAt(item, field.path);
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const { box, keepCaretAt } = useTextBox(text);
  const hint = typeof field.hint === "function" ? field.hint(item, context) : field.hint;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const control = {
    id,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": [errorId, hintId].filter(Boolean).join(" ") || undefined,
  };
  const className = `admin-field admin-span-${field.span}${error ? " admin-field-invalid" : ""}`;
  const notes = (
    <>
      {hint && (
        <span className="admin-field-hint" id={hintId}>
          {hint}
        </span>
      )}
      {error && (
        <span className="admin-field-error" id={errorId}>
          {error}
        </span>
      )}
    </>
  );

  if (field.kind === "checkbox") {
    return (
      <div className={`${className} admin-field-check`}>
        <label>
          <input
            type="checkbox"
            {...control}
            checked={value === true}
            onChange={(event) => onChange(path, event.target.checked ? true : undefined)}
          />
          {field.label}
        </label>
        {notes}
      </div>
    );
  }

  const update = (next: string) => onChange(path, next);
  let input;
  if (field.kind === "textarea") {
    input = (
      <textarea
        ref={box}
        {...control}
        rows={2}
        value={text}
        placeholder={field.placeholder}
        onChange={(event) => update(event.target.value)}
      />
    );
  } else if (field.kind === "text" || field.kind === "link") {
    input = (
      <textarea
        ref={box}
        {...control}
        {...oneLineKinds[field.kind]}
        className={field.rows === 2 ? "admin-oneline admin-oneline-tall" : "admin-oneline"}
        rows={field.rows ?? 1}
        value={text}
        placeholder={field.placeholder}
        onKeyDown={(event) => {
          // Enter that confirms an input method's word (Chinese, Japanese, some phone keyboards) is let through.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
        }}
        onChange={(event) => {
          const typed = event.target.value;
          const cleaned = typed.replace(lineBreaks, " ");
          if (cleaned !== typed) {
            const caret = event.target.selectionStart ?? typed.length;
            keepCaretAt(typed.slice(0, caret).replace(lineBreaks, " ").length);
          }
          update(cleaned);
        }}
      />
    );
  } else if (field.kind === "select") {
    input = (
      <select {...control} value={text} onChange={(event) => update(event.target.value)}>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else {
    input = (
      <input
        {...control}
        {...inputKinds[field.kind]}
        value={text}
        placeholder={field.placeholder}
        onChange={(event) => update(event.target.value)}
      />
    );
  }

  return (
    <div className={className}>
      <label htmlFor={id}>{field.label}</label>
      {input}
      {notes}
    </div>
  );
}
