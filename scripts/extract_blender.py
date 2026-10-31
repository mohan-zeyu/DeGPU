"""Extract the checksum-verified official ZIP with Windows long-path support."""
from pathlib import Path, PurePosixPath
import os, shutil, sys, zipfile
archive, target = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
def native(path):
    text=str(path)
    if os.name=='nt' and not text.startswith(chr(92)*2+'?'+chr(92)):
        if text.startswith(chr(92)*2): return chr(92)*2+'?'+chr(92)+'UNC'+chr(92)+text[2:]
        return chr(92)*2+'?'+chr(92)+text
    return text
with zipfile.ZipFile(archive) as bundle:
    for entry in bundle.infolist():
        parts=PurePosixPath(entry.filename).parts
        if not parts or parts[0]!='blender-5.2.3-windows-x64' or '..' in parts or chr(92) in entry.filename or ':' in entry.filename:
            raise ValueError('Unexpected archive path: '+entry.filename)
        dest=target.joinpath(*parts)
        os.makedirs(native(dest if entry.is_dir() else dest.parent),exist_ok=True)
        if not entry.is_dir():
            with bundle.open(entry) as src, open(native(dest),'wb') as output:
                shutil.copyfileobj(src,output,1024*1024)
print('Extracted official Blender archive with long-path support.')
