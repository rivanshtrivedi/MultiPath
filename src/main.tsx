/**
 * NEXUS AI UNIVERSAL STUDIO — minimal Vite-style shell mount.
 *
 * The real application (glassmorphism SPA) is served inline by server.mjs.
 * This module is the static-shell title page: it verifies the mount point
 * exists and renders a branded boot state while the studio takes over.
 */

type ShellRoot = HTMLElement & { dataset: DOMStringMap };

function mountShell(): void {
  const root = document.getElementById("root") as ShellRoot | null;
  if (!root) return;

  root.dataset.nexusShell = "mounted";
  root.innerHTML = `
    <main class="nexus-shell">
      <span class="omni-shell__badge">by Rivansh Trivedi</span>
      <h1 class="omni-shell__title">NEXUS</h1>
      <p class="omni-shell__sub">
        The AI Creative Operating System — studios for text, image and video with plans,
        credit wallets and billing, in one zero-dependency server.
      </p>
      <a class="omni-shell__cta" href="/">Enter the Studio →</a>
    </main>`;

  const style = document.createElement("style");
  style.textContent = `
    .omni-shell { display: grid; gap: 14px; justify-items: center; text-align: center; }
    .omni-shell__badge {
      font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase;
      padding: 6px 12px; border-radius: 999px;
      background: rgba(99, 102, 241, 0.14);
      border: 1px solid rgba(99, 102, 241, 0.35);
      color: #a5b4fc;
    }
    .omni-shell__title {
      font-size: clamp(40px, 8vw, 64px); font-weight: 800; letter-spacing: -0.03em;
      background: linear-gradient(120deg, #e0e7ff, #818cf8 55%, #22d3ee);
      -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .omni-shell__sub { color: #94a3b8; max-width: 46ch; line-height: 1.6; }
    .omni-shell__cta {
      margin-top: 6px; text-decoration: none; font-weight: 600;
      color: #0b1020; background: linear-gradient(120deg, #818cf8, #22d3ee);
      padding: 12px 22px; border-radius: 12px;
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;
  document.head.appendChild(style);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountShell, { once: true });
} else {
  mountShell();
}

export {};
