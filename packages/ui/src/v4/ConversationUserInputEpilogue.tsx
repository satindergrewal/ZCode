import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Engine-appended text inside a user message.
 *
 * Every ask a dwf subagent receives = the instruction body written by the script + a driver-appended epilogue (result criteria, the
 * `submit_result` JSON Schema), and a whole nudge turn is engine text. A reader opening the subagent transcript wants what the script
 * told it to do; the epilogue is verbatim boilerplate - so fold it into a collapsed-by-default disclosure, but never erase it:
 * debugging needs what the subagent was actually told. The engine marks the boundary at the line epilogueStart; this code only splits and folds.
 */

/** Split a line into body and epilogue. Out of range or absent -> no epilogue: better to show more than eat body text. */
export function splitUserInputEpilogue(
  text: string,
  epilogueStart: number | undefined,
): { body: string; epilogue?: string } {
  if (epilogueStart === undefined || epilogueStart < 0 || epilogueStart > text.length) {
    return { body: text };
  }
  return { body: text.slice(0, epilogueStart), epilogue: text.slice(epilogueStart) };
}

/**
 * Drop leading blank lines and the `---` separator from the epilogue: that rule is the in-source end-of-body marker, which
 * the disclosure itself already expresses; a second one is noise. A second `---` between paragraphs (quality note vs schema note) stays.
 */
function trimEpilogueLead(text: string): string {
  return text.replace(/^\s*(?:---[ \t]*\n)?/u, "").trimEnd();
}

export function ConversationUserInputEpilogue({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const label = intl.formatMessage({ id: "chat.userInput.epilogue.label" });
  return (
    <div data-v4-user-input-epilogue="true" className="flex min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded-md text-ui-xs text-foreground-subtlest transition-colors hover:text-foreground"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon aria-hidden="true" className="size-3 shrink-0" />
        )}
        {label}
      </button>
      {open ? (
        // The epilogue indented JSON Schema renders as monospace preformatted; secondary color - reference material, not message body.
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-sm text-foreground-subtle"
          data-v4-user-input-epilogue-body="true"
        >
          {trimEpilogueLead(text)}
        </pre>
      ) : null}
    </div>
  );
}
