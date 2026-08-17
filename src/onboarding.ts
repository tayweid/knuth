import type { KernelStatus } from './kernel/kernel.ts';

type Platform = 'macos' | 'windows' | 'linux';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const configuredSourceRef = import.meta.env.VITE_KNUTH_SOURCE_REF ?? '';
const sourceRef = /^[0-9a-f]{40}$/.test(configuredSourceRef)
  ? configuredSourceRef
  : 'refs/heads/main';
const sourceRequirement =
  `knuth @ https://github.com/tayweid/knuth/archive/${sourceRef}.zip#subdirectory=python`;

const COMMANDS: Record<Platform, { label: string; install: string; module: string }> = {
  macos: {
    label: 'macOS',
    install: `python3 -m pip install --upgrade --force-reinstall "${sourceRequirement}"`,
    module: 'python3 -m knuth app',
  },
  windows: {
    label: 'Windows',
    install: `py -m pip install --upgrade --force-reinstall "${sourceRequirement}"`,
    module: 'py -m knuth app',
  },
  linux: {
    label: 'Linux',
    install: `python3 -m pip install --upgrade --force-reinstall "${sourceRequirement}"`,
    module: 'python3 -m knuth app',
  },
};

function detectedPlatform(): Platform {
  const modernPlatform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform;
  const platform = (modernPlatform || navigator.platform || '').toLowerCase();
  if (platform.includes('win')) return 'windows';
  if (platform.includes('mac')) return 'macos';
  return 'linux';
}

async function copy(text: string, button: HTMLButtonElement): Promise<void> {
  const previous = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select';
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(button.previousElementSibling!);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  window.setTimeout(() => (button.textContent = previous), 1600);
}

export class Onboarding {
  private platform = detectedPlatform();
  private state: KernelStatus = 'connecting';
  private dismissed = false;
  private installPrompt: InstallPromptEvent | null = null;
  private title: HTMLElement;
  private detail: HTMLElement;
  private installCommand: HTMLElement;
  private moduleCommand: HTMLElement;
  private installAction: HTMLButtonElement;

  constructor(
    private root: HTMLElement,
    private toolbarInstall: HTMLButtonElement,
  ) {
    root.innerHTML = `
      <div class="onboarding-card">
        <header class="onboarding-head">
          <div>
            <div class="onboarding-kicker">Local Python, web interface</div>
            <h1 id="onboarding-title">Looking for the Knuth engine…</h1>
            <p id="onboarding-detail">Your documents and Python session stay on this computer.</p>
          </div>
          <button type="button" class="onboarding-dismiss" title="Continue without Python">×</button>
        </header>
        <div class="onboarding-platforms" role="tablist" aria-label="Operating system"></div>
        <div class="onboarding-steps">
          <section class="onboarding-step">
            <span class="step-number">1</span>
            <div>
              <h2>Start Knuth</h2>
              <p>The engine runs Python locally and serves this page.</p>
              <div class="command-row">
                <code>knuth app</code>
                <button type="button" class="command-copy">Copy</button>
              </div>
              <details>
                <summary>If the <code>knuth</code> command is not found</summary>
                <div class="command-row command-row-secondary">
                  <code id="engine-module-command"></code>
                  <button type="button" class="command-copy">Copy</button>
                </div>
              </details>
            </div>
          </section>
          <section class="onboarding-step">
            <span class="step-number">2</span>
            <div>
              <h2>Update the local engine</h2>
              <p>Only needed if the engine is out of date. Installs it from Knuth’s matching GitHub revision.</p>
              <div class="command-row">
                <code id="engine-install-command"></code>
                <button type="button" class="command-copy">Copy</button>
              </div>
            </div>
          </section>
          <section class="onboarding-step onboarding-install-step">
            <span class="step-number">3</span>
            <div>
              <h2>Install the web app <span>optional</span></h2>
              <p id="install-help">Use your browser’s install icon or menu to add Knuth to your applications.</p>
              <button type="button" id="onboarding-install" hidden>Install Knuth</button>
            </div>
          </section>
        </div>
        <footer class="onboarding-foot">
          This page is served by the engine on <code>127.0.0.1</code>. Your
          documents and Python session never leave this computer.
        </footer>
      </div>
    `;

    this.title = root.querySelector('#onboarding-title')!;
    this.detail = root.querySelector('#onboarding-detail')!;
    this.installCommand = root.querySelector('#engine-install-command')!;
    this.moduleCommand = root.querySelector('#engine-module-command')!;
    this.installAction = root.querySelector('#onboarding-install')!;

    const tabs = root.querySelector('.onboarding-platforms')!;
    for (const platform of ['macos', 'windows', 'linux'] as Platform[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'tab';
      button.textContent = COMMANDS[platform].label;
      button.dataset.platform = platform;
      button.addEventListener('click', () => {
        this.platform = platform;
        this.paintPlatform();
      });
      tabs.append(button);
    }
    root.querySelector('.onboarding-dismiss')!.addEventListener('click', () => {
      this.dismissed = true;
      root.hidden = true;
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>('.command-copy')) {
      button.addEventListener('click', () => {
        const command = button.previousElementSibling?.textContent ?? '';
        void copy(command, button);
      });
    }
    this.installAction.addEventListener('click', () => void this.install());
    toolbarInstall.addEventListener('click', () => void this.install());

    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt = event as InstallPromptEvent;
      this.installAction.hidden = false;
      this.toolbarInstall.hidden = false;
      root.querySelector('#install-help')!.textContent =
        'Install Knuth as a focused desktop app; the Python engine remains separate and local.';
    });
    window.addEventListener('appinstalled', () => this.markInstalled());
    if (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    ) {
      this.markInstalled();
    }
    this.paintPlatform();
  }

  setState(state: KernelStatus): void {
    this.state = state;
    if (state === 'ready') {
      this.root.hidden = true;
      return;
    }
    if (state === 'connecting') return;
    if (!this.dismissed) this.root.hidden = false;

    if (state === 'incompatible') {
      this.title.textContent = 'Update the local Python engine';
      this.detail.textContent =
        'This page and the running engine use different protocol versions. ' +
        'Update the engine, then start Knuth again.';
    } else {
      this.title.textContent = 'Start the local Python engine';
      this.detail.textContent =
        'This window is running from its cache. Start the engine to run cells ' +
        'with your local Python packages.';
    }
  }

  show(): void {
    if (this.state === 'ready') return;
    this.dismissed = false;
    this.root.hidden = false;
  }

  private paintPlatform(): void {
    const commands = COMMANDS[this.platform];
    this.installCommand.textContent = commands.install;
    this.moduleCommand.textContent = commands.module;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-platform]')) {
      const selected = button.dataset.platform === this.platform;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-selected', String(selected));
    }
  }

  private async install(): Promise<void> {
    if (!this.installPrompt) return;
    await this.installPrompt.prompt();
    const choice = await this.installPrompt.userChoice;
    if (choice.outcome === 'accepted') this.markInstalled();
    this.installPrompt = null;
  }

  private markInstalled(): void {
    this.installPrompt = null;
    this.installAction.hidden = true;
    this.toolbarInstall.hidden = true;
    const help = this.root.querySelector('#install-help');
    if (help) help.textContent = 'Knuth is installed as an app.';
  }
}
