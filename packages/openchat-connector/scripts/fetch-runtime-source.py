import urllib.request, tarfile, io, json, sys
from pathlib import Path
COMMIT = '4fc512ab8c19a2490ca73bb71777beb775ca3ae3'
if len(sys.argv) != 2: raise SystemExit('usage: python3 fetch-runtime-source.py /path/to/source-vfs.json')
raw = urllib.request.urlopen('https://api.github.com/repos/evex-dev/linejs/tarball/'+COMMIT, timeout=60).read()
files = {}
with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
 for member in archive.getmembers():
  relative='/'.join(member.name.split('/')[1:])
  if member.isfile() and (relative.startswith('packages/linejs/') or relative.startswith('packages/types/') or relative=='LICENSE') and '.test.' not in relative:
   files[relative]=archive.extractfile(member).read().decode()
Path(sys.argv[1]).write_text(json.dumps({'commit':COMMIT,'files':files}))
