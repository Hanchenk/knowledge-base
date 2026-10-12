import { randomUUID } from "node:crypto";

// Only public assistant text goes to the UI. Thinking and tool arguments stay out.
export function createTextOutput(emit, enabled = true) {
  let id,
    text = "",
    sent = "",
    timer;
  const flush = (status = "streaming") => {
    clearTimeout(timer);
    timer = undefined;
    if (!id || !text || (text === sent && status === "streaming")) return;
    emit({ type: "text", message_id: id, text, status });
    sent = text;
  };
  return {
    onEvent(event) {
      if (!enabled || event.message?.role !== "assistant") return;
      if (event.type === "message_start") {
        clearTimeout(timer);
        timer = undefined;
        id = randomUUID();
        text = sent = "";
      } else if (
        event.type === "message_update" &&
        event.assistantMessageEvent?.type === "text_delta"
      ) {
        text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (!sent) flush();
        else if (!timer) timer = setTimeout(flush, 100);
      } else if (event.type === "message_end") {
        text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        flush(
          ["error", "aborted"].includes(event.message.stopReason)
            ? "interrupted"
            : "completed",
        );
        id = undefined;
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
