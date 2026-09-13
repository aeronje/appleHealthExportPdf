# Import your export

Place Apple Health `.zip` exports directly in this folder. Any filename is accepted; `.ZIP` is accepted too.

Run `node appleHealthExportPdf.mjs` from the repository. The script always looks here, even when launched from another directory.

When several ZIPs are present, the file with the newest modification timestamp wins. Equal timestamps are resolved by filename in ascending order. Subfolders, symlinks and non-ZIP files are ignored. A selected ZIP must contain a valid Apple Health export; an invalid newest ZIP produces an error instead of silently processing an older one.

Private imports are ignored by Git. Only this guide and `.gitkeep` belong in the public repository.
