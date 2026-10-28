const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let users = [];      // hasil pencarian, buat daftar
let allUsers = [];   // semua user, buat dropdown (jangan ikut kefilter)

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- USERS ----------
async function loadUsers() {
  let hasil;
  try {
    hasil = await api('GET', `/api/users?q=${encodeURIComponent($('user-search').value)}`);
  } catch (err) {
    $('user-list').innerHTML = `<li class="hint">Gagal memuat user: ${esc(err.message)}</li>`;
    return;
  }
  users = hasil;
  $('user-list').innerHTML = users.length
    ? users.map((u) => `
        <li>
          <strong>${esc(u.name)}</strong> <span class="tag">${u.note_count} note</span>
          <div class="meta">${esc(u.email)} · id ${u.id}</div>
          <div class="actions">
            <button class="small" data-act="editUser" data-id="${u.id}">Edit</button>
            <button class="small danger" data-act="deleteUser" data-id="${u.id}">Hapus</button>
          </div>
        </li>`).join('')
    : '<li class="hint">Belum ada user.</li>';
}

function fillUserSelects() {
  const noteUser = $('note-user');
  const prevNote = noteUser.value;
  noteUser.innerHTML = '<option value="">Pilih user...</option>' +
    allUsers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  noteUser.value = prevNote;

  const filter = $('filter-user');
  const prevFilter = filter.value;
  filter.innerHTML = '<option value="">Semua user</option>' +
    allUsers.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
  filter.value = prevFilter;
}

function resetUserForm() {
  $('user-form').reset();
  $('user-id').value = '';
  $('user-form-title').textContent = 'Tambah User';
  $('user-cancel').hidden = true;
  $('user-err').textContent = '';
}

window.editUser = (id) => {
  const u = users.find((x) => x.id === id);
  if (!u) return;
  $('user-err').textContent = ''; // buang pesan error dari percobaan sebelumnya
  $('user-id').value = u.id;
  $('user-name').value = u.name;
  $('user-email').value = u.email;
  $('user-form-title').textContent = `Edit User #${u.id}`;
  $('user-cancel').hidden = false;
};

window.deleteUser = async (id) => {
  const u = users.find((x) => x.id === id);
  // bisa undefined kalau daftar lagi difilter. pakai nama generik aja, daripada
  // dialognya bunyinya "Hapus user "undefined"?"
  const nama = u ? u.name : 'user ini';
  if (!confirm(`Hapus user "${nama}"? Semua note miliknya ikut terhapus.`)) return;
  try {
    await api('DELETE', `/api/users/${id}`);
    await loadAll();
  } catch (err) {
    alert('Gagal hapus user: ' + err.message);
  }
};

$('user-form').onsubmit = async (e) => {
  e.preventDefault();
  const id = $('user-id').value;
  const body = { name: $('user-name').value, email: $('user-email').value };
  try {
    if (id) await api('PUT', `/api/users/${id}`, body);
    else await api('POST', '/api/users', body);
    resetUserForm();
    await loadAll();
  } catch (err) {
    $('user-err').textContent = err.message;
  }
};
$('user-cancel').onclick = resetUserForm;
$('user-search').oninput = () => loadUsers();

// ---------- NOTES ----------
async function loadCategories() {
  const cats = await api('GET', '/api/notes/categories');
  const filter = $('filter-category');
  const prev = filter.value;
  filter.innerHTML = '<option value="">Semua kategori</option>' +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  filter.value = prev;
  $('category-list').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
}

async function loadNotes() {
  
  const params = new URLSearchParams({
    q: $('note-search').value,
    user_id: $('filter-user').value,
    category: $('filter-category').value,
  });
  let notes;
  try {
    notes = await api('GET', `/api/notes?${params}`);
  } catch (err) {
    $('note-list').innerHTML = `<li class="hint">Gagal memuat note: ${esc(err.message)}</li>`;
    return;
  }
  $('note-count').textContent = `${notes.length} note ditemukan`;
  $('note-list').innerHTML = notes.length
    ? notes.map((n) => `
        <li>
          <strong>${esc(n.title)}</strong> <span class="tag">${esc(n.category)}</span>
          <div class="meta">oleh ${esc(n.user_name)} · diupdate ${new Date(n.updated_at).toLocaleString('id-ID')}</div>
          <div class="note-isi">${esc(n.content)}</div>
          <div class="actions">
            <button class="small" data-act="editNote" data-id="${n.id}">Edit</button>
            <button class="small danger" data-act="deleteNote" data-id="${n.id}">Hapus</button>
          </div>
        </li>`).join('')
    : '<li class="hint">Belum ada note.</li>';
}

function resetNoteForm() {
  $('note-form').reset();
  $('note-id').value = '';
  $('note-form-title').textContent = 'Tambah Note';
  $('note-cancel').hidden = true;
  $('note-err').textContent = '';
}

window.editNote = async (id) => {
  try {
    const n = await api('GET', `/api/notes/${id}`);
    $('note-err').textContent = ''; // buang pesan error dari percobaan sebelumnya
    $('note-id').value = n.id;
    $('note-user').value = n.user_id;
    $('note-title').value = n.title;
    $('note-category').value = n.category;
    $('note-content').value = n.content;
    $('note-form-title').textContent = `Edit Note #${n.id}`;
    $('note-cancel').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert('Gagal memuat note: ' + err.message);
  }
};

window.deleteNote = async (id) => {
  if (!confirm('Hapus note ini?')) return;
  try {
    await api('DELETE', `/api/notes/${id}`);
    await loadAll();
  } catch (err) {
    alert('Gagal hapus note: ' + err.message);
  }
};

$('note-form').onsubmit = async (e) => {
  e.preventDefault();
  const id = $('note-id').value;
  const body = {
    user_id: $('note-user').value,
    title: $('note-title').value,
    category: $('note-category').value,
    content: $('note-content').value,
  };
  try {
    if (id) await api('PUT', `/api/notes/${id}`, body);
    else await api('POST', '/api/notes', body);
    resetNoteForm();
    await loadAll();
  } catch (err) {
    $('note-err').textContent = err.message;
  }
};
$('note-cancel').onclick = resetNoteForm;
$('note-search').oninput = () => loadNotes();
$('filter-user').onchange = () => loadNotes();
$('filter-category').onchange = () => loadNotes();

// satu listener buat semua tombol Edit/Hapus. onclick inline nggak dipakai
// karena CSP-nya melarang script inline
document.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('button[data-act]') : null;
  if (!btn) return;
  const fn = window[btn.dataset.act];
  if (typeof fn === 'function') fn(Number(btn.dataset.id));
});

// ---------- init ----------
async function loadAll() {
  allUsers = await api('GET', '/api/users');
  fillUserSelects();
  await loadUsers();
  await loadCategories();
  await loadNotes();
}

loadAll().catch((err) => alert('Gagal load data: ' + err.message));
