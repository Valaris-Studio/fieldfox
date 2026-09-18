import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import story from '../../content/story.json'

const SortingLab = lazy(() => import('./SortingLab'))
const files = import.meta.glob('../../assets/*.{png,svg,webp,jpg}', { query: '?url', import: 'default', eager: true }) as Record<string, string>
const diagrams = import.meta.glob(['../../content/*.svg', '../../exports/*.svg'], { query: '?url', import: 'default', eager: true }) as Record<string, string>
const artOrder = ['sorting-machine', 'sorting-machine-exploded', 'source-specimen', 'review-station']
const diagramOrder = ['fieldfox-overview.svg', 'source-to-form.svg', 'trust-boundaries.svg', 'same-widget-two-homes.svg']
const art = Object.entries(files).filter(([path]) => !path.includes('thumbnail')).map(([path, src]) => ({
  name: path.split('/').pop()!.replace(/\.[^.]+$/, ''), src,
})).sort((a, b) => artOrder.indexOf(a.name) - artOrder.indexOf(b.name))
const titles: Record<string, string> = {
  'sorting-machine': 'The tiny sorting laboratory', 'source-specimen': 'The information you already have',
  'review-station': 'A place for a second look', 'sorting-machine-exploded': 'A friendly machine, taken apart',
}
const diagramTitles: Record<string, string> = {
  'fieldfox-overview.svg': 'FieldFox, at a glance', 'source-to-form.svg': 'Follow the information', 'trust-boundaries.svg': 'Where the information goes',
  'same-widget-two-homes.svg': 'Same widget. Two homes.',
}
type View = 'story' | 'gallery' | 'foundation'

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function Brand() {
  return <span className="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M4 4 13 10 19 10 28 4 26 22 16 29 6 22Z" fill="currentColor"/><path d="m10 17 6 6 6-6" fill="none" stroke="var(--surface)" strokeWidth="3"/></svg>fieldfox</span>
}

function Stage({ active, technical, paused, foundation }: { active: number; technical: boolean; paused: boolean; foundation?: boolean }) {
  const [exploded, setExploded] = useState(false)
  const [turn, setTurn] = useState(0)
  const [reset, setReset] = useState(0)
  return <div className={`stage ${foundation ? 'foundation-stage' : ''}`}>
    <div className="stage-top mono"><span><i className="status-dot"/> {foundation ? 'SCENE / 001' : 'FIG. 01 / SORTING LABORATORY'}</span><span>ILLUSTRATIVE</span></div>
    <div className="scene-wrap"><Suspense fallback={<div className="scene-loading mono">Assembling the little laboratory…</div>}><SortingLab key={reset} step={active} exploded={exploded} paused={paused} technical={technical} turn={turn}/></Suspense></div>
    {technical && !foundation && <div className="annotation mono"><span className="annotation-tick">↳</span> {['SOURCE / TEXT + IMAGES', 'SCHEMA / SUPPORTED CONTROLS', 'REQUEST / SERVER → PROVIDER', 'APPLY / WRITE + READBACK', 'HUMAN / REVIEW BEFORE SUBMISSION', 'DEPLOY / SHARED WIDGET'][active]}</div>}
    <div className="stage-bottom"><span className="mono stage-hint">DRAG TO EXPLORE ↗</span><div className="scene-controls"><button onClick={() => setTurn(v => v - 1)} aria-label="Rotate model left">↶</button><button onClick={() => setTurn(v => v + 1)} aria-label="Rotate model right">↷</button><button aria-pressed={exploded} onClick={() => setExploded(v => !v)}>{exploded ? 'Reassemble' : 'Take apart'} <span aria-hidden="true">↗</span></button><button aria-label="Reset camera and model" onClick={() => { setTurn(0); setExploded(false); setReset(v => v + 1) }}>Reset</button></div></div>
    {!foundation && <div className="mini-route mono" aria-label="Information route"><span>YOUR BROWSER</span><b>⇄</b><span>SERVER</span><b>⇄</b><span>MODEL PROVIDER</span></div>}
    {!foundation && <p className="stage-caption">A physical metaphor for software. Source and form information leave the browser for the configured server and model provider.</p>}
  </div>
}

function Example() {
  return <section className="specimen-section" aria-labelledby="specimen-heading"><div className="section-kicker mono"><span>SPECIMEN / 001</span><span>INVENTED EXAMPLE</span></div><div className="specimen-heading"><h2 id="specimen-heading">Same information.<br/>A more useful shape.</h2><p>Keep the source close. Keep your own judgment closer.</p></div><div className="specimen-grid"><div className="source-sheet"><span className="mono">SOURCE / SUPPLIER NOTE</span><img className="example-art" src={art.find(item => item.name === 'source-specimen')?.src} alt="Illustrative source documents waiting to be sorted" loading="lazy"/><blockquote>{story.example.sourceText}</blockquote><span className="paper-corner" aria-hidden="true">↗</span></div><div className="field-sheet"><span className="mono">ILLUSTRATIVE FIELD VALUES</span>{story.example.fields.map(field => <div className={`field-row ${field.state}`} key={field.label}><div><span>{field.label}</span><small>{field.state === 'excluded' ? 'Hands off' : field.state === 'omitted' ? 'Not in source' : 'Proposed'}</small></div><strong>{field.value || 'Leave empty'}</strong>{field.reason && <p>{field.reason}</p>}</div>)}<div className="review-note"><span aria-hidden="true">✳</span><p>Your review belongs here.<br/><strong>FieldFox never submits the form.</strong></p></div></div></div><p className="mono specimen-footnote">{story.example.label}</p></section>
}

function Gallery() {
  return <><section className="gallery-intro"><span className="mono">THE RESOURCE SHELF / EXPLORATION 01</span><h1>Little things.<br/>Big explanations.</h1><p>Images, diagrams and a dimensional idea. Pick the pieces that feel like FieldFox.</p></section><section className="art-grid" aria-label="Generated illustration library">{art.length ? art.map((item, i) => <figure key={item.name} className={i === 0 ? 'featured-art' : ''}><a href={item.src} target="_blank" rel="noreferrer" aria-label={`Open ${titles[item.name] || item.name} full size`}><img src={item.src} alt={titles[item.name] || item.name.replaceAll('-', ' ')} loading={i ? 'lazy' : 'eager'} /></a><figcaption><span className="mono">FIG. {String(i + 2).padStart(2, '0')}</span><h2>{titles[item.name] || item.name.replaceAll('-', ' ')}</h2><a href={item.src} download={`${item.name}.png`} className="mono">Download asset ↗</a></figcaption></figure>) : <p className="pending-art">The illustration shelf is being assembled. Explore the diagrams below.</p>}</section><DiagramShelf /></>
}

function DiagramShelf() {
  return <section className="diagram-section" aria-labelledby="diagram-heading"><div className="section-kicker mono"><span>DIAGRAM LIBRARY</span><span>EDITABLE / SVG</span></div><h2 id="diagram-heading">Make the invisible<br/>easy to follow.</h2>{Object.entries(diagrams).sort(([a], [b]) => diagramOrder.indexOf(a.split('/').pop()!) - diagramOrder.indexOf(b.split('/').pop()!)).map(([path, src], i) => { const name = path.split('/').pop()!; return <figure className="diagram" key={path}><div className="diagram-title"><h3><span className="mono">0{i + 1} / </span>{diagramTitles[name] || name}</h3><a className="mono" href={src} download={name}>Download SVG ↗</a></div><a href={src} target="_blank" rel="noreferrer" aria-label={`Open ${diagramTitles[name]} full size`}><img src={src} alt={diagramTitles[name] || name} loading="lazy" /></a></figure>})}</section>
}

export default function App() {
  const initial = new URLSearchParams(location.search).get('view')
  const [view, setView] = useState<View>(initial === 'gallery' || initial === 'foundation' ? initial : 'story')
  const [technical, setTechnical] = useState(false)
  const [manualPause, setManualPause] = useState(false)
  const reduced = useReducedMotion()
  const paused = manualPause || reduced
  const [active, setActive] = useState(0)
  const storyRoot = useRef<HTMLDivElement>(null)
  const changeView = (next: View) => { setView(next); history.replaceState(null, '', next === 'story' ? location.pathname : `?view=${next}`); window.scrollTo({ top: 0, behavior: 'instant' }); requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true })) }
  useEffect(() => {
    if (view !== 'story') return
    const nodes = storyRoot.current?.querySelectorAll<HTMLElement>('[data-chapter]')
    if (!nodes) return
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.chapter)) })
    }, { rootMargin: '-20% 0px -45% 0px', threshold: 0 })
    nodes.forEach(node => observer.observe(node))
    return () => observer.disconnect()
  }, [view])
  return <><a className="skip-link" href="#main">Skip to content</a><header className="site-header"><a href="?view=story" aria-label="Fieldfox story studio" onClick={e => { e.preventDefault(); changeView('story') }}><Brand /></a><nav aria-label="Studio views"><button aria-current={view === 'story' ? 'page' : undefined} onClick={() => changeView('story')}>The story</button><button aria-current={view === 'gallery' ? 'page' : undefined} onClick={() => changeView('gallery')}>Resource shelf</button><button aria-current={view === 'foundation' ? 'page' : undefined} onClick={() => changeView('foundation')}>Site foundation <span aria-hidden="true">↗</span></button></nav><span className="edition mono">DESIGN STUDY<br/>VOL. 001 / SEP 2026</span></header><div className="control-bar"><span className="mono"><span className="draft-dot"/> LOCAL EXPLORATION · NOT A LIVE PRODUCT</span>{view !== 'gallery' && <div><button className="toggle" aria-pressed={technical} onClick={() => setTechnical(v => !v)}><span className="toggle-track"><i/></span>Under the hood</button><button className="motion-button mono" aria-pressed={paused} disabled={reduced} onClick={() => setManualPause(v => !v)}>{reduced ? 'REDUCED MOTION' : paused ? 'RESUME MOTION ▷' : 'PAUSE MOTION Ⅱ'}</button></div>}</div><main id="main" tabIndex={-1}>
    {view === 'foundation' ? <section className="foundation"><div className="foundation-label"><span className="mono">FOUNDATION / CONTENT UNASSIGNED</span><p>A spatial starting point.</p></div><Stage active={0} technical={technical} paused={paused} foundation/><div className="foundation-footer mono"><span>REACT THREE FIBER / INTERACTION / LIGHT / SPACE</span><span>RESERVED FOR THE FUTURE WEBSITE</span></div></section> : view === 'gallery' ? <Gallery /> : <><div className="story-layout" ref={storyRoot}><div className="story-copy"><section className="introduction"><span className="mono">A TINY FIELD LABORATORY</span><h1>From bits.<br/>To boxes<span className="orange">.</span></h1><p className="intro-lead">{story.lead}</p><p className="intro-detail">A friendly way to explain a careful piece of software. Follow the information, one little step at a time.</p><a href="#gather" className="start-link">Let's sort it out <span aria-hidden="true">↓</span></a><span className="intro-footnote mono">A VISUAL METAPHOR. NOT A LIVE FILL.</span></section>{story.chapters.map((chapter, index) => <section key={chapter.id} id={chapter.id} data-chapter={index} className={`chapter ${active === index ? 'chapter-active' : ''}`}><div className="chapter-label mono"><span>{chapter.number} / {chapter.label.toUpperCase()}</span><span>↓</span></div><h2>{chapter.headline}</h2><p>{chapter.body}</p>{technical && <aside className="technical-note"><span className="mono">UNDER THE HOOD</span><p>{chapter.technical}</p></aside>}<div className="chapter-symbol" aria-hidden="true">{['↳', '⊞', '⇄', '↺', '✳', '⌂'][index]}</div></section>)}</div><aside className="scene-column" aria-label="Interactive illustrative sorting laboratory"><div className="scene-sticky"><Stage active={active} technical={technical} paused={paused}/><div className="chapter-progress" aria-label="Story chapters">{story.chapters.map((chapter, index) => <a key={chapter.id} href={`#${chapter.id}`} aria-label={`${chapter.number}: ${chapter.label}`} aria-current={active === index ? 'step' : undefined}><span>{chapter.number}</span><i/></a>)}</div></div></aside></div><Example/><DiagramShelf/><section className="shelf-invitation"><span className="mono">THERE'S MORE ON THE SHELF</span><h2>A few ways<br/>to tell the story.</h2><button onClick={() => changeView('gallery')}>Open the resource shelf <span aria-hidden="true">↗</span></button></section></>}
  </main><footer className="site-footer"><Brand/><p>Exploratory resources for review.<br/>Cloud is pre-launch; self-hosting is available for evaluation.</p><span className="mono">ILLUSTRATIVE, NOT A BENCHMARK<br/>AVAILABILITY AS OF {story.availabilityAsOf}</span></footer></>
}
