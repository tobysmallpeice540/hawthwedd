import { useEffect, useState } from 'react'
import { rpc } from './supabase.js'

// Inspiration boards — the farm's, and the couple's own.
//
// LINKS, NOT EMBEDS, and deliberately. Pinterest's board widget works by
// loading their JavaScript into this page, and this page holds a guest list,
// names, access needs and a live session. A third-party script here could read
// all of it. That is a real trade for a prettier tab and not one to make
// quietly, so every board opens in its own window instead.
//
// The address is checked server-side against Pinterest's own domains before it
// is stored, because staff click these links from the admin side and an
// unchecked one is somewhere to hang a phishing page wearing the farm's
// branding. See wp_is_board_url().

export default function Pinterest() {
  const [data, setData] = useState(null)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function load() {
    try { setData(await rpc('wp_get_boards')) }
    catch (e) { setErr(e.message || String(e)); setData({ venue: [], mine: [] }) }
  }
  useEffect(() => { load() }, [])

  async function add(e) {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      await rpc('wp_add_board', { p_label: label, p_url: url })
      setLabel(''); setUrl(''); setAdding(false)
      await load()
    } catch (e2) {
      setErr(
        e2.code === 'not_a_pinterest_link'
          ? 'That does not look like a Pinterest link. It should start with https://www.pinterest.co.uk/ or https://pinterest.com/.'
        : e2.code === 'too_many_boards'
          ? 'That is eight boards already — remove one first.'
        : (e2.message || String(e2))
      )
    } finally { setBusy(false) }
  }

  async function remove(id) {
    setBusy(true); setErr('')
    try { await rpc('wp_delete_board', { p_id: id }); await load() }
    catch (e2) { setErr(e2.message || String(e2)) }
    finally { setBusy(false) }
  }

  if (!data) return <section className="card"><p className="muted">Loading…</p></section>

  const venue = data.venue || []
  const mine = data.mine || []

  return (
    <>
      {venue.length > 0 && (
        <section className="card">
          <h3>From us</h3>
          <p className="muted" style={{ fontSize: 14 }}>
            Boards we keep of the barn dressed for real weddings. Worth a look before
            you decide anything — the light in here changes a lot through the day.
          </p>
          <div className="boards">
            {venue.map((b) => <BoardLink key={b.id} board={b} />)}
          </div>
        </section>
      )}

      <section className="card">
        <div className="list-head">
          <div>
            <h3 style={{ marginBottom: 4 }}>Your boards</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              Add as many as you like — flowers, tables, dresses, whatever you are
              collecting. We will look at them before we talk, which saves describing
              a colour over email.
            </p>
          </div>
          {mine.length > 0 && <span className="count">{mine.length}</span>}
        </div>

        {mine.length > 0 && (
          <div className="boards">
            {mine.map((b) => (
              <BoardLink key={b.id} board={b} onRemove={() => remove(b.id)} busy={busy} />
            ))}
          </div>
        )}

        {mine.length === 0 && !adding && (
          <p className="muted" style={{ fontSize: 14, padding: '10px 0' }}>Nothing added yet.</p>
        )}

        {adding ? (
          <form className="editor" onSubmit={add}>
            <label>What is it?</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="Flowers" autoFocus />
            <label>The board's address</label>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://www.pinterest.co.uk/yourname/flowers/" />
            <p className="hint">
              Open the board in Pinterest and copy what is in the address bar. If it is
              a secret board, only people you have shared it with can open it — and that
              includes us.
            </p>
            {err && <div className="alert alert-warn">{err}</div>}
            <div className="actions">
              <button className="btn-small" type="submit" disabled={busy}>
                {busy ? 'Adding…' : 'Add'}
              </button>
              <button className="btn-small ghost" type="button"
                onClick={() => { setAdding(false); setErr('') }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            {err && <div className="alert alert-warn">{err}</div>}
            <div className="actions">
              <button className="btn-small" onClick={() => setAdding(true)}>Add a board</button>
            </div>
          </>
        )}
      </section>
    </>
  )
}

function BoardLink({ board, onRemove, busy }) {
  return (
    <div className="board">
      <a href={board.url} target="_blank" rel="noopener noreferrer" className="board-name">
        {board.label}
      </a>
      {onRemove && (
        <button className="btn-small ghost" onClick={onRemove} disabled={busy}>Remove</button>
      )}
    </div>
  )
}
