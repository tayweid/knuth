// Plass's menus (plass/src/toolbar.ts), for the bar's File tile: a text
// menu in the frame's dark glass that drops under its tile on a click, its
// submenus (Recent, Get Knuth) taking its place with a way back. The same
// rules as Plass's: a click on the tile opens it on its first item, a
// second click, a click elsewhere, Escape or Tab closes it; the arrows,
// Home, End and a letter walk it; ArrowRight opens a submenu and
// ArrowLeft goes back. One difference: closing hands the focus back to
// wherever it was when the menu opened — the cell being typed in, or the
// tile when it was opened from the keyboard — so Escape never reaches the
// cell (where it starts the Esc-Y/S/M chord) and a File action leaves the
// typing where it was. Tab goes on from the tile, as in Plass.

export interface Menu {
  element: HTMLElement;
  anchor: HTMLButtonElement;
  parent?: Menu;
  /** Called each time the menu opens (Recent loads its list). */
  refresh?: () => void;
}

export interface ItemOptions {
  id?: string;
  title?: string;
  shortcut?: string;
  submenu?: Menu;
  /** Runs without closing the menu (the way back from a submenu). */
  stay?: boolean;
}

export interface Menus {
  create(name: string, anchor: HTMLButtonElement, parent?: Menu): Menu;
  /** A menu with no tile: opened at the pointer (openAt), by a right click. */
  context(name: string): Menu;
  openAt(menu: Menu, x: number, y: number): void;
  item(parent: Menu | HTMLElement, label: string, run: () => void, options?: ItemOptions): HTMLButtonElement;
  divider(menu: Menu): HTMLElement;
  heading(menu: Menu, label: string): HTMLElement;
  hint(parent: Menu | HTMLElement, text: string): HTMLElement;
  /** The way back to the parent menu, at the head of a submenu. */
  back(menu: Menu, label: string): void;
  close(restoreFocus?: boolean): void;
}

export function menus(): Menus {
  let openMenu: Menu | null = null;
  let returnFocus: HTMLElement | null = null;

  const close = (restoreFocus = false, toAnchor = false) => {
    if (!openMenu) return;
    const { element, anchor } = openMenu;
    element.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    openMenu = null;
    const back = returnFocus;
    returnFocus = null;
    if (!restoreFocus) return;
    const target = !toAnchor && back && back !== document.body && back.isConnected ? back : anchor;
    target.focus({ preventScroll: true });
  };
  const buttons = (menu: Menu) =>
    [...menu.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([hidden])')]
      .filter((button) => !button.closest('[hidden]:not(.tb-menu)'));
  const show = (menu: Menu, focus = false, point?: { x: number; y: number }) => {
    if (!openMenu) {
      const held = document.activeElement;
      returnFocus = held instanceof HTMLElement ? held : null;
    } else {
      // A submenu replaces its parent in place: the focus to hand back
      // stays the one from when the first of them opened.
      const keep = returnFocus;
      close();
      returnFocus = keep;
    }
    menu.refresh?.();
    openMenu = menu;
    menu.element.hidden = false;
    menu.anchor.setAttribute('aria-expanded', 'true');
    menu.anchor.setAttribute('aria-controls', menu.element.id);
    // Under its tile in the bar, or at the pointer for a right click (up
    // from it when there is no room below). Geometry is read only when a
    // menu opens.
    const rect = menu.anchor.getBoundingClientRect();
    const { style } = menu.element;
    let top = point ? point.y + 2 : rect.bottom + 10;
    if (point && top + menu.element.offsetHeight > window.innerHeight - 8) top = Math.max(8, point.y - menu.element.offsetHeight - 2);
    style.top = `${top}px`;
    style.maxHeight = `${Math.max(80, window.innerHeight - top - 8)}px`;
    style.left = `${Math.max(8, Math.min(point ? point.x + 2 : rect.left, window.innerWidth - menu.element.offsetWidth - 8))}px`;
    if (focus) buttons(menu)[0]?.focus();
  };
  const create = (name: string, anchor: HTMLButtonElement, parent?: Menu, tile = true): Menu => {
    const element = document.createElement('div');
    element.id = `tb-menu-${name.toLowerCase().replaceAll(' ', '-')}`;
    element.className = 'tb-menu';
    element.setAttribute('role', 'menu');
    element.setAttribute('aria-label', name);
    element.hidden = true;
    document.body.append(element);
    const menu: Menu = { element, anchor, parent };
    if (!parent && tile) {
      anchor.setAttribute('aria-haspopup', 'menu');
      anchor.setAttribute('aria-expanded', 'false');
      anchor.setAttribute('aria-controls', element.id);
      // The tile takes no focus from a click: the cell keeps it until the
      // menu opens, and gets it back when it closes.
      anchor.addEventListener('mousedown', (e) => e.preventDefault());
      anchor.addEventListener('click', () => {
        if (openMenu && openMenu.anchor === anchor) close(true);
        else show(menu, true);
      });
      anchor.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          show(menu, true);
          if (e.key === 'ArrowUp') buttons(menu).at(-1)?.focus();
        }
      });
    }
    return menu;
  };

  document.addEventListener('mousedown', (e) => {
    const target = e.target as Node;
    if (openMenu && !openMenu.element.contains(target) && !openMenu.anchor.contains(target)) close();
  }, true);
  window.addEventListener('resize', () => close());
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === 'Tab') {
      // On from the tile, where Tab would have gone from it.
      close(true, true);
      return;
    }
    if (!openMenu.element.contains(e.target as Node) && e.target !== openMenu.anchor) return;
    const list = buttons(openMenu);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1
        : (index + (e.key === 'ArrowUp' ? -1 : 1) + list.length) % list.length;
      list[next]?.focus();
    } else if (e.key === 'ArrowLeft' && openMenu.parent) {
      e.preventDefault();
      const childId = openMenu.element.id;
      const parent = openMenu.parent;
      show(parent);
      parent.element.querySelector<HTMLButtonElement>(`[aria-controls="${childId}"]`)?.focus();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== ' ') {
      const ordered = [...list.slice(index + 1), ...list.slice(0, index + 1)];
      const match = ordered.find((button) => button.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
      if (match) {
        e.preventDefault();
        match.focus();
      }
    }
  });

  const host = (parent: Menu | HTMLElement) => (parent instanceof HTMLElement ? parent : parent.element);
  const item = (parent: Menu | HTMLElement, label: string, run: () => void, options: ItemOptions = {}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tb-menu-item';
    button.tabIndex = -1;
    button.setAttribute('role', 'menuitem');
    if (options.id) button.id = options.id;
    button.title = options.title ?? label;
    const text = document.createElement('span');
    text.className = 'tb-menu-label';
    text.textContent = label;
    button.append(text);
    if (options.shortcut || options.submenu) {
      const shortcut = document.createElement('kbd');
      shortcut.textContent = options.shortcut ?? '›';
      shortcut.setAttribute('aria-hidden', 'true');
      button.append(shortcut);
    }
    const submenu = options.submenu;
    if (submenu) {
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-controls', submenu.element.id);
      button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          show(submenu, true);
        }
      });
    }
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      if (submenu) show(submenu, true);
      else if (options.stay) run();
      else {
        close(true);
        run();
      }
    });
    host(parent).append(button);
    return button;
  };
  const divider = (menu: Menu) => {
    const rule = document.createElement('div');
    rule.className = 'tb-menu-divider';
    rule.setAttribute('role', 'separator');
    menu.element.append(rule);
    return rule;
  };
  const heading = (menu: Menu, label: string) => {
    const title = document.createElement('div');
    title.className = 'tb-menu-heading';
    title.textContent = label;
    title.setAttribute('role', 'presentation');
    menu.element.append(title);
    return title;
  };
  const hint = (parent: Menu | HTMLElement, text: string) => {
    const note = document.createElement('div');
    note.className = 'tb-menu-hint';
    note.textContent = text;
    host(parent).append(note);
    return note;
  };
  const back = (menu: Menu, label: string) => {
    const parent = menu.parent;
    if (!parent) return;
    // Not a close: the parent takes the submenu's place.
    item(menu, `‹ ${label}`, () => show(parent, true), { title: `Back to ${label}`, stay: true });
    divider(menu);
  };
  // Its anchor is a button nowhere in the page: closing hands the focus
  // back to wherever it was (the cell), never to a tile.
  const context = (name: string) => create(name, document.createElement('button'), undefined, false);
  const openAt = (menu: Menu, x: number, y: number) => show(menu, false, { x, y });
  return { create, context, openAt, item, divider, heading, hint, back, close: (restoreFocus = false) => close(restoreFocus) };
}
