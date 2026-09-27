import {
  AppWindow,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  BrickWall,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  CloudFog,
  Dices,
  DoorClosed,
  DoorOpen,
  Eye,
  EyeOff,
  FilePlus2,
  Flame,
  FlaskConical,
  GripVertical,
  Hand,
  History,
  Image as ImageIcon,
  LocateFixed,
  Lock,
  LockOpen,
  Mail,
  Maximize2,
  Minus,
  MousePointer2,
  Orbit,
  Paintbrush,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  Presentation,
  Redo2,
  Ruler,
  Scan,
  ScrollText,
  Skull,
  Sparkles,
  SquareDashed,
  Sun,
  Swords,
  Trash2,
  Undo2,
  UserRound,
  UserX,
  X,
  Zap,
  type IconNode,
} from 'lucide';

/**
 * Padrao de icones da mesa.
 *
 * Todo icone vem do Lucide, desenhado na mesma grade de 24px e com o mesmo
 * traco, e passa por este arquivo. Antes eram emojis e caracteres soltos
 * (⬚, 🧱, ✕, ▤...): cada sistema operacional os desenhava de um jeito, com
 * tamanhos e pesos diferentes, e o mesmo gesto aparecia com simbolos
 * diferentes em cada painel.
 *
 * Regras:
 *
 *  - Pede-se o icone pelo que ele SIGNIFICA (`close`, `delete`, `roll`), nunca
 *    pelo desenho. Trocar o desenho de um significado muda a mesa inteira de
 *    uma vez, e dois gestos iguais nao acabam com simbolos diferentes.
 *  - `close` (X) fecha ou tira de uma lista sem apagar nada. `delete`
 *    (lixeira) apaga de vez. A distincao e o aviso visual de que ha perda.
 *  - Tamanhos: `sm` (14px) em etiquetas e botoes pequenos, `md` (16px) no
 *    resto dos botoes, `lg` (18px) no trilho de ferramentas.
 *  - Icone decorativo ao lado de texto fica escondido do leitor de tela; icone
 *    sozinho num botao precisa de `label` (ou de `aria-label` no botao).
 *
 * O pacote base (`lucide`) e usado no lugar do `lucide-react` porque entrega os
 * icones como dados. A mesma fonte desenha o SVG da interface e as condicoes
 * sobre os tokens no canvas — que nao sao elementos React.
 */
/**
 * Dados poliedricos, desenhados aqui.
 *
 * Sao os unicos icones autorais do conjunto. O Lucide tem o dado de seis faces
 * com pontinhos, mas nao tem d4, d8, d10, d12 nem d20 — e escolher entre eles
 * e exatamente o que a pessoa faz na hora de rolar, entao cada um precisa ter
 * a silhueta do solido de verdade. Mesma grade de 24px e mesmo traco do resto,
 * para nao destoarem ao lado dos icones do Lucide.
 */
const D4: IconNode = [
  ['polygon', { points: '12 2.5 22 20 2 20' }],
  ['line', { x1: '12', y1: '13.5', x2: '12', y2: '2.5' }],
  ['line', { x1: '12', y1: '13.5', x2: '2', y2: '20' }],
  ['line', { x1: '12', y1: '13.5', x2: '22', y2: '20' }],
];

const D6: IconNode = [
  ['polygon', { points: '12 2 21 7 12 12 3 7' }],
  ['polyline', { points: '3 7 3 17 12 22 21 17 21 7' }],
  ['line', { x1: '12', y1: '12', x2: '12', y2: '22' }],
];

const D8: IconNode = [
  ['polygon', { points: '12 2 21 12 12 22 3 12' }],
  ['polyline', { points: '3 12 12 16 21 12' }],
  ['line', { x1: '12', y1: '2', x2: '12', y2: '16' }],
];

const D10: IconNode = [
  ['polygon', { points: '12 2 21 10 17 20.5 7 20.5 3 10' }],
  ['polyline', { points: '3 10 12 14 21 10' }],
  ['line', { x1: '12', y1: '14', x2: '12', y2: '20.5' }],
];

const D12: IconNode = [
  ['polygon', { points: '12 2 21.5 9 17.8 20.5 6.2 20.5 2.5 9' }],
  ['polygon', { points: '12 7 16.6 10.4 14.8 15.9 9.2 15.9 7.4 10.4' }],
];

const D20: IconNode = [
  ['polygon', { points: '12 2 21 7.5 21 16.5 12 22 3 16.5 3 7.5' }],
  ['polygon', { points: '12 6.5 17 15.5 7 15.5' }],
  ['line', { x1: '12', y1: '6.5', x2: '12', y2: '2' }],
  ['line', { x1: '17', y1: '15.5', x2: '21', y2: '16.5' }],
  ['line', { x1: '7', y1: '15.5', x2: '3', y2: '16.5' }],
];

export const ICONS = {
  // dados
  d4: D4,
  d6: D6,
  d8: D8,
  d10: D10,
  d12: D12,
  d20: D20,

  // ferramentas do mapa
  select: MousePointer2,
  pan: Hand,
  measure: Ruler,
  ping: LocateFixed,
  fogReveal: Sun,
  fogHide: CloudFog,
  wall: BrickWall,
  tile: ImageIcon,
  brush: Paintbrush,
  area: SquareDashed,
  sealed: Lock,
  unsealed: LockOpen,
  partyVision: Eye,
  undo: Undo2,
  redo: Redo2,
  fitMap: Scan,

  // paredes
  door: DoorOpen,
  doorClosed: DoorClosed,
  window: AppWindow,

  // acoes genericas
  add: Plus,
  remove: Minus,
  close: X,
  delete: Trash2,
  moveUp: ArrowUp,
  moveDown: ArrowDown,
  grip: GripVertical,
  previous: ChevronLeft,
  next: ChevronRight,
  expand: ChevronDown,
  collapse: ChevronUp,
  collapsed: ChevronRight,
  panelHide: PanelRightClose,
  panelShow: PanelRightOpen,
  expandView: Maximize2,

  // fichas, turnos e jogadores
  portrait: UserRound,
  locked: Lock,
  roll: Dices,
  equipped: Swords,
  sheet: ScrollText,
  newSheet: FilePlus2,
  handout: Mail,
  present: Presentation,
  skipTurn: Pause,
  resumeTurn: Play,
  combat: Swords,
  history: History,
  vision: Eye,
  promote: ChevronsUp,
  demote: ChevronsDown,
  kick: UserX,

  // condicoes sobre os tokens
  stunned: Orbit,
  poisoned: FlaskConical,
  prone: ArrowDownToLine,
  blinded: EyeOff,
  burning: Flame,
  blessed: Sparkles,
  hasted: Zap,
  dead: Skull,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof ICONS;

const SIZES = { sm: 14, md: 16, lg: 18 } as const;
export type IconSize = keyof typeof SIZES;

/** Traco um pouco mais fino no tamanho grande, para o peso visual empatar. */
function strokeFor(px: number): number {
  return px >= 18 ? 1.75 : 2;
}

export function Icon({
  name,
  size = 'md',
  label,
  className,
}: {
  name: IconName;
  size?: IconSize;
  /** Texto para leitor de tela quando o icone e o unico conteudo. */
  label?: string;
  className?: string;
}): JSX.Element {
  const px = SIZES[size];
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={px}
      height={px}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeFor(px)}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {ICONS[name].map(([tag, attrs], i) => {
        const Tag = tag as keyof JSX.IntrinsicElements;
        return <Tag key={i} {...toReactAttrs(attrs)} />;
      })}
    </svg>
  );
}

/** Atributos SVG em kebab-case viram as props camelCase que o React espera. */
function toReactAttrs(attrs: Record<string, string | number | undefined>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const dataUrls = new Map<string, string>();

/**
 * O mesmo icone como imagem SVG, para desenhar no canvas.
 *
 * Devolve uma URL `data:` estavel por icone e cor; o cache de imagens do mapa
 * a carrega uma vez e avisa quando pode desenhar.
 */
export function iconDataUrl(name: IconName, color: string, strokeWidth = 2): string {
  const key = `${name}|${color}|${strokeWidth}`;
  const cached = dataUrls.get(key);
  if (cached) return cached;

  const children = ICONS[name]
    .map(([tag, attrs]) => {
      const rendered = Object.entries(attrs)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}="${escapeAttr(String(v))}"`)
        .join(' ');
      return `<${tag} ${rendered}/>`;
    })
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${escapeAttr(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">` +
    `${children}</svg>`;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  dataUrls.set(key, url);
  return url;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// Condicoes
// ---------------------------------------------------------------------------

/**
 * Icone e cor de cada condicao. A cor diz a natureza de relance: ameaca em
 * vermelho e laranja, bencao em latao, veneno em verde.
 */
export const CONDITION_ICONS: Record<string, { icon: IconName; color: string }> = {
  stunned: { icon: 'stunned', color: '#e8c95a' },
  poisoned: { icon: 'poisoned', color: '#7fd17a' },
  prone: { icon: 'prone', color: '#c9ccd6' },
  blinded: { icon: 'blinded', color: '#7fb3d8' },
  burning: { icon: 'burning', color: '#f08a3c' },
  blessed: { icon: 'blessed', color: '#d9a441' },
  hasted: { icon: 'hasted', color: '#6fd6e8' },
  dead: { icon: 'dead', color: '#e5675e' },
};
