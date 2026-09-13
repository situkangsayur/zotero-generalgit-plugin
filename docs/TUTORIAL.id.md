# Tutorial: mencadangkan pustaka Zotero ke host Git mana pun

Panduan ini memasang Zotero Git Sync, menghubungkannya ke repositori di GitLab, Gitea,
Forgejo, Codeberg, Bitbucket atau server sendiri, lalu menjalankan sinkronisasi pertama.
Kira-kira lima belas menit, ditambah waktu unggah PDF Anda.

*English: [TUTORIAL.md](TUTORIAL.md)*

---

## 1. Pasang git (dan git-lfs)

Plugin menjalankan program `git` di komputer Anda.

| Sistem | Cara pasang |
| --- | --- |
| Windows | [Git for Windows](https://git-scm.com/download/win) — sudah termasuk Git LFS |
| macOS | `brew install git git-lfs`, atau `xcode-select --install` untuk git saja |
| Debian/Ubuntu | `sudo apt install git git-lfs` |
| Fedora | `sudo dnf install git git-lfs` |
| Arch | `sudo pacman -S git git-lfs` |

Git LFS dipakai untuk lampiran di atas 50 MB. Kalau tidak dipasang, matikan *Store files
larger than … with Git LFS* di langkah 5.

Tutup dan buka lagi Zotero setelah memasang git.

## 2. Buat repositori

Di host Git Anda, buat repositori baru yang **kosong**, misalnya `zotero-library`. Jadikan
**private** kecuali Anda ingin pustaka terbuka. Jangan tambahkan README.

Kalau lampiran Anda besar, pastikan **LFS** aktif untuk repositori itu (bawaan aktif di
GitLab, Gitea/Forgejo dan Bitbucket) dan cek batas penyimpanan host.

## 3. Pastikan git bisa masuk tanpa bertanya

Plugin tidak bisa menjawab pertanyaan password, jadi git harus bisa mengakses repositori
sendiri. Pilih salah satu:

### Pilihan A: kunci SSH (disarankan)

1. Kalau belum punya kunci: `ssh-keygen -t ed25519` (tekan Enter untuk nilai bawaan).
2. Tambahkan kunci **publik** (`~/.ssh/id_ed25519.pub`) ke akun Anda di host:
   - GitLab: *Preferences → SSH Keys*
   - Gitea / Forgejo / Codeberg: *Settings → SSH / GPG Keys*
   - Bitbucket: *Personal settings → SSH keys*
   - Server sendiri: tambahkan ke `~/.ssh/authorized_keys` milik user git
3. Kalau kunci memakai passphrase, muat ke SSH agent (`ssh-add`); kebanyakan desktop sudah
   melakukannya saat login.
4. Sambungkan sekali dari terminal dan jawab **yes** saat ditanya host key:

   ```sh
   ssh -T git@gitlab.com
   ```

### Pilihan B: HTTPS dengan credential helper

Kalau dari terminal Anda sudah bisa push lewat HTTPS tanpa mengetik password, git sudah punya
credential helper dan tidak perlu apa-apa lagi.

### Pilihan C: HTTPS dengan access token di plugin

Buat access token di host dengan izin baca dan tulis repositori:

| Host | Tempat | User name yang diisi |
| --- | --- | --- |
| GitLab | *Preferences → Access tokens*, scope `read_repository`, `write_repository` | username GitLab Anda |
| Gitea / Forgejo / Codeberg | *Settings → Applications → Generate token*, repository: read and write | username Anda |
| Bitbucket | *Settings* repositori *→ Access tokens* (read + write) | `x-token-auth` |

Token ditempel di plugin pada langkah 5.

### Cek

```sh
git ls-remote <alamat repositori>
```

Kalau tidak mencetak apa-apa dan tidak ada error, berarti berhasil (repositori kosong belum
punya branch). Kalau muncul pertanyaan, plugin akan macet di titik yang sama — kembali ke
pilihan A, B atau C.

## 4. Pasang plugin

1. Unduh `zotero-git-sync-<versi>.xpi` dari
   [halaman Releases](https://github.com/situkangsayur/zotero-generalgit-plugin/releases/latest).
   Di Firefox, klik kanan tautannya lalu *Save Link As…*.
2. Di Zotero: **Tools → Plugins**, ikon roda gigi, **Install Plugin From File…**, pilih berkasnya.

Tombol Git Sync muncul di kanan atas jendela utama, di sebelah tombol sinkronisasi Zotero.

## 5. Hubungkan ke repositori

Buka **Edit → Settings → Git Sync** (macOS: **Zotero → Settings**).

### Repository

| Kolom | Isi |
| --- | --- |
| Repository address | Alamat clone, misalnya `git@gitlab.com:anda/zotero-library.git` |
| Branch | `main` |
| Folder inside the repository | `zotero` (bawaan), atau kosong untuk akar repositori |

Klik **Test connection**. Hasil yang benar menulis *Connected to …*, versi git dan git-lfs,
serta atas nama siapa commit dibuat.

### HTTPS sign-in (hanya pilihan C)

Isi user name, tempel token, klik **Save token**, lalu **Test connection** lagi.

### What gets synced

Semuanya menyala secara bawaan: metadata item, catatan Markdown, catatan anak, pustaka grup,
berkas lampiran dan linked file. Berkas di atas 50 MB masuk Git LFS. Git menyimpan setiap
versi berkas, jadi mengganti PDF membuat repositori terus bertambah besar.

### Commits

Kosongkan kolom author untuk memakai identitas git Anda (`git config --global user.name`).

### When to sync

| Pilihan | Kapan sinkron |
| --- | --- |
| *Sync every … minutes* | Berkala |
| *Sync after the library changes* | Beberapa menit setelah Anda berhenti mengedit |
| *Sync shortly after Zotero starts* | Satu menit setelah Zotero dibuka |
| *Sync to Git after Zotero's own sync finishes* | Setiap kali Zotero sinkron |

Sinkronisasi yang tidak menemukan perubahan tidak membuat commit.

## 6. Jalankan sinkronisasi pertama

Klik **tombol Git Sync** di toolbar, atau **Sync now** di pengaturan. Ikon berputar dan
menampilkan persentase; klik untuk membuka jendela progres.

Pada sinkronisasi pertama:

1. **Memeriksa berkas lampiran.** Setiap berkas di-hash sekali; sinkron berikutnya memakai
   hasilnya.
2. **Berkas besar ke Git LFS.**
3. **Metadata dan catatan** disimpan dan dikirim lebih dulu.
4. **Berkas lampiran** menyusul bertahap — satu commit dikirim setiap 100 MB atau 1.000
   berkas. Kalau sinkron dibatalkan, gagal, atau Zotero ditutup, semua checkpoint yang sudah
   terkirim tetap ada, dan sinkron berikutnya melanjutkan dari situ.
5. **Commit terakhir** berisi daftar berkas yang dikelola plugin.

Untuk menghentikan: klik kanan tombol → **Cancel Git Sync**.

Setelah selesai, repositori berisi pustaka Anda:

- `zotero/my-library/items/` — satu JSON per item, lengkap dengan catatan, lampiran dan anotasi
- `zotero/my-library/notes/` — halaman Markdown per item (bisa dibuka di Obsidian)
- `zotero/my-library/attachments/` dan `attachments-lfs/` — berkas-berkasnya
- `zotero/my-library/index.md` — daftar isi per koleksi

Plugin juga menyimpan salinan lokal repositori (terkompresi) di folder `git-sync` dalam folder
data Zotero. Ukurannya kira-kira sebesar lampiran Anda.

## 7. Kalau ada masalah

Tombol berubah merah. Arahkan kursor untuk membaca pesannya, atau lihat **Status** di
pengaturan.

| Pesan | Solusi |
| --- | --- |
| *git was not found* | Pasang git lalu buka ulang Zotero, atau isi *git program* di Advanced |
| *SSH does not know this server yet* | Jalankan `ssh -T git@<host>` sekali di terminal, jawab yes |
| *The server did not accept an SSH key* | Tambahkan kunci publik di host; `ssh-add` untuk kunci ber-passphrase |
| *The server refused the HTTPS credentials* | Periksa user name dan token, atau pasang credential helper |
| *The repository was not found* | Periksa alamat; buat repositorinya dulu |
| *… stopped responding* | git menunggu pertanyaan: pakai pilihan A, B atau C di langkah 3 |
| *Git LFS is not installed* | Pasang git-lfs, atau matikan Git LFS |
| *refused the push because of a size limit or quota* | Turunkan ambang LFS, lewati berkas yang sangat besar, cek batas host |

Nyalakan **Help → Debug Output Logging** sebelum sinkron untuk rincian; baris plugin diawali
`[Git Sync]` dan mencantumkan setiap perintah git.

## 8. Sinkron dari lebih dari satu komputer

Tiap komputer mengingat apa yang terakhir disinkronkannya, sehingga plugin bisa membedakan
perubahan Anda dari perubahan di tempat lain. Kalau ada yang perlu diputuskan, panel tinjauan
terbuka di dalam jendela Zotero:

| Bagian | Artinya | Pilihan Anda |
| --- | --- | --- |
| **Changes in the repository** | Diubah atau ditambah di tempat lain, tidak berubah di sini | Centang untuk mengimpor; yang tidak dicentang ditanyakan lagi lain kali |
| **Changed in both places** | Diubah di sini *dan* di tempat lain | Simpan versi Zotero, ambil versi repositori, atau — untuk berkas — simpan keduanya |
| **Deleted in the repository, still in Zotero** | Komputer lain menghapusnya | Centang untuk mengunggah lagi; untuk menerima penghapusan, hapus item di Zotero |
| **Edited in the repository, generated by the plugin** | Seseorang mengedit catatan Markdown atau indeks | Dibuat ulang dari pustaka; hilangkan centang untuk membiarkannya kali ini |
| **Files this sync replaces or deletes** | Perubahan Anda sendiri | Hilangkan centang untuk mengecualikan berkas dari sinkron ini |

Sinkron latar belakang tidak pernah menunggu Anda: ia hanya mengirim yang aman dan membiarkan
sisanya, dan tombol menampilkan titik oranye. Klik tombol itu, atau **Tools → Git Sync →
Review Changes and Sync…**.

## 9. Memulihkan di komputer lain

1. Pasang git, Zotero dan plugin; siapkan cara masuk (langkah 3) dan alamat repositori yang sama.
2. **Tools → Git Sync → Import from Git…**

Import menambahkan item yang belum ada (dengan key yang sama, sehingga anotasi kembali ke PDF
yang benar), memperbarui item yang versi repositorinya lebih baru, membuat ulang koleksi,
saved search dan warna tag, serta memulihkan berkas lampiran ke folder storage Zotero. Import
tidak pernah menghapus apa pun.

## Perlu diketahui

- **Zotero tetap sumber kebenaran.** Perubahan di repositori baru masuk ke pustaka kalau Anda
  menerimanya di panel tinjauan, dan sinkronisasi tidak pernah menghapus apa pun dari pustaka.
- **Repositori yang sama bisa dipakai Zotero GitHub Sync** kalau berada di GitHub; kedua
  plugin menulis format yang sama.
- **Pindah host** cukup dengan `git push --mirror`, lalu ganti alamat di plugin. (Salin juga
  objek LFS dengan `git lfs fetch --all` dan `git lfs push --all`.)
