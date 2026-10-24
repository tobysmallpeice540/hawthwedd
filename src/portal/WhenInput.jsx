// A date or time box that looks like the other boxes and, while empty, says
// what goes in it — "DD/MM/YYYY" or "00:00" — so it reads as somewhere to tap.
// Phones draw an empty date or time box as a small blank sliver otherwise.
//
// The hint sits over the box and lets taps through; the browser's own empty
// pattern is hidden underneath it so the two never show at once.
export default function WhenInput({ type, value, className, ...rest }) {
  const empty = value === '' || value === null || value === undefined
  return (
    <span className={'when' + (empty ? ' is-empty' : '')}>
      <input type={type} value={value || ''} className={className} {...rest} />
      {empty && <span className="when-ph" aria-hidden="true">{type === 'time' ? '00:00' : 'DD/MM/YYYY'}</span>}
    </span>
  )
}
