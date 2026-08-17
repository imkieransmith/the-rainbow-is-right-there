import { FakeCanvas } from './fake-canvas.js';

export class FakeClassList {
  constructor(initial = '') { this.values = new Set(initial.split(/\s+/).filter(Boolean)); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : !!force;
    enabled ? this.add(name) : this.remove(name);
    return enabled;
  }
  toString() { return [...this.values].join(' '); }
}

function matches(element, selector) {
  if (!element) return false;
  if (selector.startsWith('#')) return element.id === selector.slice(1);
  if (selector.startsWith('.')) return element.classList?.contains(selector.slice(1));
  const data = selector.match(/^\[data-([\w-]+)\]$/);
  if (data) return Object.hasOwn(element.dataset || {}, data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  return element.tagName?.toLowerCase() === selector.toLowerCase();
}

export class FakeElement {
  constructor(document, tagName = 'div', { id = '', className = '', dataset = {} } = {}) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.classList = new FakeClassList(className);
    this.dataset = { ...dataset };
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    // Inline styles behave as plain properties, plus the custom-property API
    // the game uses to hand the generated sprite sheet over to CSS.
    this.style = {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] ?? ''; },
    };
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.removed = false;
    this._textContent = '';
    this.scrollTop = 0;
    this.clientHeight = 100;
    this.scrollHeight = 200;
    this.onclick = null;
    this.oncancel = null;
    this.onclose = null;
    this.onscroll = null;
    if (id) document.elements.set(id, this);
    document.all.push(this);
  }

  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = String(value); }

  get className() { return this.classList.toString(); }
  set className(value) { this.classList = new FakeClassList(String(value)); }

  append(...children) {
    for (const child of children) {
      // Appending a node that already has a parent moves it, exactly as the
      // real DOM does — the game relies on that to push the Catch row back to
      // the bottom of the list after cloning the rows above it.
      if (child.parentElement) {
        child.parentElement.children = child.parentElement.children.filter(node => node !== child);
      }
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  /**
   * Deep copy, the way cloneNode(true) does: same tag, classes, dataset and
   * attributes, and a fresh copy of every descendant. Clones join the
   * document so querySelectorAll can find them, but they deliberately keep no
   * id — the game only ever clones rows that carry none.
   */
  cloneNode() {
    const copy = new FakeElement(this.ownerDocument, this.tagName, {
      className: this.classList.toString(),
      dataset: { ...this.dataset },
    });
    copy.attributes = new Map(this.attributes);
    copy._textContent = this._textContent;
    copy.append(...this.children.map(child => child.cloneNode()));
    return copy;
  }

  descendants() {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  querySelector(selector) { return this.descendants().find(element => matches(element, selector)) || null; }
  querySelectorAll(selector) { return this.descendants().filter(element => matches(element, selector)); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node;
    return null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { this.ownerDocument.activeElement = this; this.focused = true; }
  remove() {
    this.removed = true;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
  showModal() { this.open = true; }
  close() {
    if (!this.open) return;
    this.open = false;
    this.onclose?.({ target: this });
  }
  scrollBy(options) {
    this.scrollTop += typeof options === 'number' ? options : options?.top || 0;
    this.onscroll?.({ target: this });
  }
  getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 200, width: 300, height: 200 }; }
}

const make = (document, tag, options, ...children) =>
  new FakeElement(document, tag, options).append(...children);

/**
 * The single upgrade row index.html declares. The game clones it for the other
 * two, so this has to mirror the real markup's shape and ordering — in
 * particular the blank pennant, and the title <strong> coming before the
 * effect readout's <strong>.
 */
function addUpgradeRow(document, list, key) {
  const pips = make(document, 'span', { className: 'pips' });
  for (let i = 0; i < 10; i++) pips.append(new FakeElement(document, 'i', { className: 'pip' }));
  const button = new FakeElement(document, 'button', { dataset: { up: key } });
  list.append(make(document, 'div', { className: `row ${key}` },
    make(document, 'span', { className: 'flag' }),
    make(document, 'div', { className: 'copy' },
      make(document, 'div', { className: 'title' }, new FakeElement(document, 'strong')),
      new FakeElement(document, 'small', { className: 'desc' }),
      make(document, 'small', { className: 'effect' },
        new FakeElement(document, 'span'),
        new FakeElement(document, 'b', { className: 'now' }),
        new FakeElement(document, 'i'),
        new FakeElement(document, 'strong', { className: 'next' })),
      pips),
    make(document, 'div', { className: 'buy' },
      make(document, 'span', { className: 'cost' },
        new FakeElement(document, 'span', { className: 'costlabel' }),
        new FakeElement(document, 'b', { className: 'costvalue' })),
      button)));
  return button;
}

/** The single Stubbornness row index.html declares; the game clones the rest. */
function addStubbornChoice(document, list, key) {
  const button = new FakeElement(document, 'button', { dataset: { stubborn: key }, textContent: 'Choose' });
  list.append(make(document, 'div', { className: `choice ${key}` },
    make(document, 'span', { className: 'flag' }),
    make(document, 'span', { className: 'scopy' },
      new FakeElement(document, 'strong'),
      new FakeElement(document, 'span'),
      make(document, 'small', {},
        new FakeElement(document, 'b', { className: 'lvl' }),
        new FakeElement(document, 'b', { className: 'now' }),
        new FakeElement(document, 'i'),
        new FakeElement(document, 'strong', { className: 'next' }))),
    button));
  return button;
}

export function createFakeDocument({ width = 240, height = 140 } = {}) {
  const document = {
    elements: new Map(),
    all: [],
    activeElement: null,
    hidden: false,
    listeners: new Map(),
    canvasCount: 0,
    addEventListener(type, callback, options) {
      const listeners = this.listeners.get(type) || [];
      listeners.push({ callback, capture: options === true || !!options?.capture });
      this.listeners.set(type, listeners);
    },
    // The production build lifts the game's markup out of index.html into the
    // packed script and replays it with document.write while the parser is
    // still inside <body>. The double records what was written so a bundle
    // test can prove it is exactly the markup index.html declares; the element
    // tree every other test works against is the hand-built one below, which
    // mirrors that same markup.
    written: [],
    write(html) { this.written.push(html); },
    getElementById(id) { return this.elements.get(id) || null; },
    querySelector(selector) {
      if (selector.startsWith('#')) return this.elements.get(selector.slice(1)) || null;
      return this.all.find(element => matches(element, selector)) || null;
    },
    querySelectorAll(selector) { return this.all.filter(element => matches(element, selector)); },
    createElement(tagName) {
      if (tagName.toLowerCase() === 'canvas') {
        const canvas = new FakeCanvas(`canvas-${++this.canvasCount}`);
        this.canvases.push(canvas);
        return canvas;
      }
      return new FakeElement(this, tagName);
    },
  };
  document.canvases = [];
  document.documentElement = new FakeElement(document, 'html');
  // Keep a conventional document shell even though bundle tests only record
  // the parser-written style and markup; the exercised element tree is built
  // explicitly below rather than parsed by this lightweight fake.
  document.head = new FakeElement(document, 'head');
  document.body = new FakeElement(document, 'body');
  document.documentElement.append(document.head, document.body);

  const element = (id, tag = 'div', options = {}) => document.body.append(new FakeElement(document, tag, { id, ...options })).children.at(-1);
  const canvas = new FakeCanvas('screen', width, height);
  canvas.id = 'c';
  canvas.ownerDocument = document;
  canvas.classList = new FakeClassList();
  canvas.attributes = new Map();
  canvas.style = {};
  canvas.hidden = false;
  canvas.setAttribute = FakeElement.prototype.setAttribute;
  canvas.getAttribute = FakeElement.prototype.getAttribute;
  document.elements.set('c', canvas);
  document.all.push(canvas);
  document.canvases.push(canvas);

  const genericIds = [
    'hud','hud-money','hud-upgrade',
    'upgrade-title','upgrade-bio','upgrade-close','game-volume','game-new','upgrade-scroll-cue','upgrade-more','upgrade-money',
    'upgrade-chase','catch-requirement','stubborn-profile-title','stubborn-profile-bio','stubborn-description',
    'stubborn-catches','stubborn-status',
  ];
  for (const id of genericIds) element(id, id.includes('close') || id.includes('more') || id.startsWith('game-') || id === 'hud-upgrade' ? 'button' : 'div');

  document.elements.get('hud').hidden = true;
  document.elements.get('hud-upgrade').hidden = true;

  const upgradeMenu = element('upgrade-menu', 'dialog');
  const upgradeList = element('upgrade-list');
  upgradeList.parentElement = upgradeMenu;
  upgradeMenu.children.push(upgradeList);
  addUpgradeRow(document, upgradeList, 'mane');
  const catchRow = new FakeElement(document, 'div', { className: 'row catch' });
  const catchButton = new FakeElement(document, 'button', { id: 'catch-rainbow' });
  document.elements.set('catch-rainbow', catchButton);
  catchRow.append(catchButton);
  upgradeList.append(catchRow);

  const stubbornMenu = element('stubborn-menu', 'dialog');
  const stubbornBody = new FakeElement(document, 'div', { className: 'sbody' });
  const stubbornList = new FakeElement(document, 'div', { id: 'stubborn-list' });
  document.elements.set('stubborn-list', stubbornList);
  stubbornBody.append(stubbornList);
  stubbornMenu.append(stubbornBody);
  addStubbornChoice(document, stubbornList, 'drop');

  return document;
}

export function createEvent(type, target, values = {}) {
  return {
    type,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    ...values,
  };
}

export function dispatchDocumentEvent(document, event) {
  const listeners = document.listeners.get(event.type) || [];
  for (const listener of listeners.filter(item => item.capture)) listener.callback(event);
  for (let node = event.target; node; node = node.parentElement) node[`on${event.type}`]?.(event);
  for (const listener of listeners.filter(item => !item.capture)) listener.callback(event);
  return event;
}
