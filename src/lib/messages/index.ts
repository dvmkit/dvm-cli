export {
  appendMessage,
  appendMessages,
  createMessageAppendSession,
  getHighestSeq,
  loadMessages,
  type MessageAppendSession,
} from "./store";
export type {
  ApprovalContent,
  ArtifactContent,
  CancelContent,
  PaymentContent,
  ResponseContent,
} from "@dvmkit/sdk";
export type {
  CompleteContent,
  Message,
  MessageFrom,
  MessageType,
  PaymentRequestContent,
  PromptContent,
  TextContent,
  WorkingContent,
} from "@dvmkit/sdk/internal";
export {
  isArtifactMessage,
  isCancelMessage,
  isCompleteMessage,
  isPaymentRequestMessage,
  isPromptMessage,
  isTextMessage,
  isWorkingMessage,
} from "@dvmkit/sdk/internal";

export function maxSeq(msgs: { seq: number }[], fallback: number): number {
  if (msgs.length === 0) return fallback;
  return Math.max(...msgs.map((m) => m.seq));
}
