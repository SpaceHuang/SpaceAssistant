import io, re, hashlib, subprocess
s = subprocess.run(['git', 'show', 'HEAD~1:electron/wiki/wikiTemplates.ts'], capture_output=True, text=True, encoding='utf-8').stdout
m = re.search(r'export const DEFAULT_SCHEMA_MD = `(.*?)`\n', s, re.S)
content = m.group(1)
content = content.replace('\\`', '`')
h = hashlib.sha256(content.encode('utf-8')).hexdigest()
io.open('.probe/legacy_schema_v1.txt', 'w', encoding='utf-8', newline='\n').write(content)
print('HASH:', h)
print('LEN:', len(content))
