/** Exact whole-message matches only: never swallow a task appended to a greeting. */
export function instantReply(command: string): string | undefined {
  const text = command.trim().toLowerCase().replace(/[!.?]+$/g, '').trim();
  if (/^(?:hi|hello|hey|hiya|yo|sup|hi again|hey there|hi rove|hello rove|hey rove|good morning|good afternoon|good evening)$/.test(text)) return 'Hey! What’s on your mind?';
  if (/^(?:thanks|thank you|thanks rove|thank you rove|ty)$/.test(text)) return 'You’re welcome!';
  if (/^(?:how are you|how are you doing|how's it going|how’s it going)$/.test(text)) return 'Ready when you are. What are we working on?';
  if (/^(?:who are you|what can you do|what do you do|how can you help)$/.test(text)) return 'I’m Rove. I can answer questions, work in your browser, open apps, and run saved routines. What would you like to get done?';
}

export function requiresAction(command: string) {
  return /^(?:(?:please|can you|could you|would you)\s+)?(?:open|close|launch|start|delete|move|copy|click|fill|send|submit|save|install|download|run|find|search|browse|increase|lower|turn)\b|\b(?:and|then|also)\s+(?:open|close|launch|delete|run|send|click|fill)\b|\b(?:screen|clipboard|installed|running applications|current volume)\b/i.test(command.trim());
}

/** A deliberately narrow informational path; local/current-state questions still need tools. */
export function isConversation(command: string) {
  if (requiresAction(command)) return false;
  if (/\b(?:my|this|current|latest|today|search|browse|website|https?|file|folder|screen|window|running|installed|account|weather|news|price|stock|volume|computer|desktop|clipboard)\b/i.test(command)) return false;
  return /^(?:what (?:is|are|does|can)|who\b|why\b|how (?:does|do|can|would)\b|do you\b|are you\b|can we (?:talk|chat)\b|i(?:'m| am)\b|explain\b|tell me about\b|write (?:a |an )?(?:poem|story|joke)\b)/i.test(command.trim());
}
