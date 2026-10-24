// Push-to-talk wrapper around the Web Speech API (webkitSpeechRecognition in Chrome/Edge/Safari).
// start() begins listening; stop() ends it and resolves with the final transcript.

// lib.dom doesn't ship SpeechRecognition types, so declare the slice we use.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const speechSupported = (): boolean => getCtor() !== null;

export class PushToTalk {
  private rec: SpeechRecognitionLike | null = null;
  private finalText = "";
  private interimText = "";
  private error: string | null = null;
  private ended: Promise<void> | null = null;

  /** Called with the running (final + interim) transcript while listening. */
  constructor(private onPartial?: (text: string) => void) {}

  get listening(): boolean {
    return this.rec !== null;
  }

  start(): void {
    const Ctor = getCtor();
    if (!Ctor) throw new Error("Speech recognition isn't supported in this browser (try Chrome).");
    if (this.rec) return;
    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    this.finalText = "";
    this.interimText = "";
    this.error = null;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.interimText = interim;
      this.onPartial?.((this.finalText + interim).trim());
    };
    rec.onerror = (e) => {
      // "no-speech" / "aborted" just mean an empty result, not a failure.
      if (e.error !== "no-speech" && e.error !== "aborted") this.error = e.error;
    };
    this.ended = new Promise((resolve) => {
      rec.onend = () => resolve();
    });
    this.rec = rec;
    rec.start();
  }

  /** Stops listening and resolves with the transcript ("" if nothing was heard). */
  async stop(): Promise<string> {
    const rec = this.rec;
    if (!rec) return "";
    rec.stop(); // flushes pending audio into a final result, then fires onend
    await this.ended;
    this.rec = null;
    if (this.error) throw new Error(`speech error: ${this.error}`);
    // Chrome sometimes ends before promoting the last interim chunk to final.
    return (this.finalText || this.interimText).trim();
  }

  cancel(): void {
    this.rec?.abort();
    this.rec = null;
  }
}
