import { Input } from "@futbotao/shared";

const KEY_BITS: Record<string, number> = {
  ArrowUp: Input.up,
  KeyW: Input.up,
  ArrowDown: Input.down,
  KeyS: Input.down,
  ArrowLeft: Input.left,
  KeyA: Input.left,
  ArrowRight: Input.right,
  KeyD: Input.right,
  Space: Input.kick,
  KeyX: Input.kick,
  ShiftLeft: Input.dash,
  ShiftRight: Input.dash,
  KeyC: Input.dash,
};

const QUICK_CHAT_KEYS: Record<string, number> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3 };

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  );
}

/**
 * Lê o teclado e só avisa quando o estado muda: assim o cliente manda
 * poucas mensagens e fica bem dentro da cota gratuita da Cloudflare.
 */
export function listenKeyboard(opts: {
  enabled(): boolean;
  onChange(bits: number): void;
  onQuickChat(index: number): void;
  onTogglePanel(): void;
}) {
  const held = new Set<string>();
  let bits = 0;

  const update = () => {
    let next = 0;
    for (const code of held) next |= KEY_BITS[code] ?? 0;
    if (next !== bits) {
      bits = next;
      opts.onChange(bits);
    }
  };

  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape") {
      opts.onTogglePanel();
      return;
    }
    if (isTyping(e.target) || !opts.enabled()) return;
    if (e.code in KEY_BITS) {
      e.preventDefault();
      held.add(e.code);
      update();
    } else if (e.code in QUICK_CHAT_KEYS && !e.repeat) {
      opts.onQuickChat(QUICK_CHAT_KEYS[e.code]!);
    }
  });
  window.addEventListener("keyup", (e) => {
    if (held.delete(e.code)) update();
  });
  const releaseAll = () => {
    held.clear();
    update();
  };
  window.addEventListener("blur", releaseAll);
  return { releaseAll };
}
