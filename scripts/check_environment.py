from pathlib import Path
import importlib, json, sys
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
failures = []
def check(name, good, detail=''):
    print(f"{'PASS' if good else 'FAIL'} {name}: {detail}")
    if not good: failures.append(name)
check('Python 3.12', sys.version_info[:2] == (3,12), sys.version.split()[0])
for module in ('web3', 'nacl', 'onnxruntime', 'PIL', 'numpy', 'Crypto', 'fastapi', 'uvicorn', 'multipart'):
    try: importlib.import_module(module); check(module, True)
    except ImportError as e: check(module, False, str(e))
for file in ('degpu/web/index.html', 'assets/mobilenetv2.onnx', 'assets/demo_scene.blend'):
    check(file, (root/file).is_file())
check('demo images', len(list((root/'assets').rglob('*.jpg'))) >= 200)
for name in ('ProviderRegistry','ReplicatedMarket','CheckedMarket','KeySearchChecker'):
    try:
        path = next((root/'contracts/out').glob('*.sol/'+name+'.json'))
        artifact = json.loads(path.read_text(encoding='utf-8'))
        check(name, bool(artifact['abi']) and len(artifact['bytecode']['object']) > 10)
    except (StopIteration,KeyError,ValueError) as e: check(name,False,str(e))
# This optional diagnostic never turns a missing renderer into an install failure.
from degpu.runtime import task_runtime
from degpu.tasks import get
runtime = task_runtime(get('blender-render-v1'))
print('OPTIONAL Blender: ' + json.dumps(runtime))
print('Blender 5.2.x is only required when this computer provides rendering services.')
sys.exit(bool(failures))
