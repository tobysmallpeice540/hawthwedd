import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL  = 'https://rkqbyisfmvwulsyxzwjz.supabase.co'
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJrcWJ5aXNmbXZ3dWxzeXh6d2p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NTI0MzgsImV4cCI6MjA5NjUyODQzOH0._CsyhvFrtHFC0KrfiLzbrLUaKcvxtbWlHydaH20tvfo'

// TWO THINGS HERE ARE DELIBERATE AND BOTH WILL BITE IF CHANGED.
//
// detectSessionInUrl: true
//   The staff client sets this to false, which is right for a password login.
//   A magic link arrives as a token in the URL fragment, so the portal must
//   read it. With this off the link appears to do nothing at all.
//
// storageKey
//   The staff app and the portal are served from the SAME ORIGIN, so they share
//   localStorage. On the default key, signing into the portal would silently
//   sign Toby out of the diary, and vice versa. A distinct key keeps the two
//   sessions side by side in one browser — which is exactly what happens when
//   he opens a client's portal to check something.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'hbf-portal-auth',
  },
})

// Every read goes through here. The house rule after four silent-failure
// incidents: never treat an unchecked response as valid data. A failed RPC
// throws; it does not return an empty object that the UI then renders as
// "you have no wedding".
export async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args || {})
  if (error) throw new Error(fn + ': ' + error.message)
  if (data && data.ok === false) {
    const e = new Error(data.error || 'unknown')
    e.code = data.error
    throw e
  }
  return data
}
