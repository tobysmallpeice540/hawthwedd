// Small line icons for the tabs and the to-do list. Drawn here rather than
// pulled from a package: thirteen shapes do not justify a dependency in a
// bundle a client downloads on their phone. 24×24, stroke only, so they take
// the colour of the text around them.

const PATHS = {
  overview:    'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  guests:      'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .8 3.2 2.5 3.5 5.2',
  food:        'M6 3v8M4 3v5a2 2 0 0 0 4 0V3M6 11v10M17 3c-2 1.5-3 4-3 7h3v11',
  checklist:   'M4 5h3v3H4zM4 11h3v3H4zM4 17h3v3H4zM10 6.5h10M10 12.5h10M10 18.5h10',
  timeline:    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3.5 2',
  drinks:      'M6 3h12l-1.5 8.5a4.5 4.5 0 0 1-9 0zM6.6 7h10.8M12 15.5V21M8.5 21h7',
  bar:         'M7 3h10l-1.2 16.6a1.5 1.5 0 0 1-1.5 1.4H9.7a1.5 1.5 0 0 1-1.5-1.4zM7.4 8.5h9.2',
  uploads:     'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15 9.5h.01M12 3v4M10 5l2-2 2 2',
  webcast:     'M3 6h13v10H3zM16 10l5-3v8l-5-3M7 20h5M9.5 16v4',
  music:       'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  suppliers:   'M4 8h16v12H4zM9 8V5h6v3M4 13h16',
  layout:      'M3 4h18v16H3zM7 8h4v3H7zM13 13h4v3h-4zM7 15h2M15 8h2',
  items:       'M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5zM3.5 7.5 12 12l8.5-4.5M12 12v9',
  addons:      'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 8v8M8 12h8',
  money:       'M15.5 6.5A4 4 0 0 0 8.5 9v3.5c0 2.5-1 4.5-2.5 5.5h12M6 12.5h7',
  details:     'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
  documents:   'M3 6.5h6l2 2h10V19H3zM3 6.5V5h6',
  inspiration: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15 9.5h.01',
  alert:       'M12 4 2.5 20h19zM12 10v4.5M12 17.5h.01',
  done:        'M4.5 12.5 9.5 17.5 19.5 6.5',
  arrow:       'M5 12h14M13 6l6 6-6 6',
}

export default function Icon({ name, size = 18, className }) {
  const d = PATHS[name]
  if (!d) return null
  return (
    <svg className={'icon' + (className ? ' ' + className : '')} width={size} height={size}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  )
}
