"""Desktop lifecycle wrapper; wallet registration and jobs use the original app."""
from pathlib import Path
import argparse
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request

MODES = {
    'classroom': {'host': 18600, 'client': 18701, 'p1': 18703, 'p2': 18704, 'p3': 18705, 'p4': 18706},
    'solo': {'host': 18600, 'client': 18701},
    'join': {'client': 18701},
    'host': {'host': 18600, 'client': 18701},
}


def atomic_json(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def fetch(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return json.load(response)


def worker(args):
    sys.path.insert(0, str(args.root))
    import uvicorn
    from degpu.api import App, create_app, WEB_DIR
    from degpu.host import Host
    resource = None
    done = threading.Event()
    try:
        if args.worker == 'host':
            resource = Host(args.root / '.local' / 'networks' / args.session).start()
            application = resource.app()
        else:
            resource = App(args.network)
            application = create_app(resource, web_dir=WEB_DIR)
        bind = '0.0.0.0' if args.mode == 'host' and args.worker == 'host' else '127.0.0.1'
        server = uvicorn.Server(uvicorn.Config(application, host=bind,
            port=MODES[args.mode][args.worker], log_level='warning'))
        def monitor():
            while not done.wait(.2):
                if args.stop_file.exists():
                    server.should_exit = True
                    break
        threading.Thread(target=monitor, daemon=True).start()
        server.run()
    finally:
        done.set()
        if resource is not None:
            if args.worker == 'host':
                resource.stop()
            else:
                resource.lock()


def supervise(args):
    control = args.root / '.local' / 'launcher' / args.session
    control.mkdir(parents=True, exist_ok=True)
    state_file = control / 'state.json'
    stop = control / 'STOP'
    report = {'session': args.session, 'mode': args.mode, 'status': 'starting',
              'network': args.network, 'apps': {}, 'pid': os.getpid(), 'error': ''}
    processes, logs = {}, {}
    # Do not overwrite an active session's status when launched a second time.
    sockets = []
    try:
        for name, port in MODES[args.mode].items():
            sock = socket.socket()
            sockets.append(sock)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            try:
                sock.bind(('0.0.0.0' if args.mode == 'host' and name == 'host' else '127.0.0.1', port))
            except OSError:
                print(f'端口 {port} 已由其他程序使用。请关闭之前的演示；启动器不会结束无关进程。', flush=True)
                return 2
    finally:
        for sock in sockets:
            sock.close()
    stop.unlink(missing_ok=True)
    atomic_json(state_file, report)
    failed = False
    try:
        for role, port in MODES[args.mode].items():
            role_stop = control / (role + '.stop')
            role_stop.unlink(missing_ok=True)
            env = os.environ.copy()
            env['PYTHONUTF8'] = '1'
            env['PATH'] = str(args.root / '.tools' / 'bin') + os.pathsep + env['PATH']
            env['DEGPU_HOME'] = str(args.root / '.local' / 'profiles' / (args.session + '_' + role))
            blender = args.root / '.tools' / 'blender-5.2.3-windows-x64' / 'blender.exe'
            if not env.get('DEGPU_BLENDER') and blender.exists():
                env['DEGPU_BLENDER'] = str(blender)
            logs[role] = (control / (role + '.log')).open('w', encoding='utf-8')
            command = [sys.executable, '-u', str(Path(__file__).resolve()), '--root', str(args.root),
                       '--mode', args.mode, '--session', args.session, '--network', args.network,
                       '--worker', role, '--stop-file', str(role_stop)]
            proc = subprocess.Popen(command, cwd=args.root, env=env, stdout=logs[role],
                                    stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
            processes[role] = proc
            endpoint = f'http://127.0.0.1:{port}' + ('/network.json' if role == 'host' else '/api/status')
            for attempt in range(200):
                if stop.exists():
                    return 0
                if proc.poll() is not None:
                    raise RuntimeError(f'{role} 启动失败，请查看 {role}.log')
                try:
                    state = fetch(endpoint)
                    break
                except (OSError, ValueError):
                    time.sleep(.2)
            else:
                raise RuntimeError(f'{role} 启动超时，请查看日志。')
            if role == 'host':
                report['registry'] = state['registry']
            else:
                report['apps'][role] = {'url': f'http://127.0.0.1:{port}', 'pid': proc.pid,
                    'profile': args.session + '_' + role, 'unlocked': state['unlocked']}
            atomic_json(state_file, report)
        report['status'] = 'ready'
        atomic_json(state_file, report)
        print('READY', flush=True)
        while not stop.exists():
            for role, proc in processes.items():
                if proc.poll() is not None:
                    raise RuntimeError(f'{role} 意外停止，请查看日志。')
            time.sleep(.3)
    except Exception as exc:
        failed = True
        report['error'] = str(exc)
        print(str(exc), flush=True)
    finally:
        report['status'] = 'stopping'
        atomic_json(state_file, report)
        for role in processes:
            if role != 'host':
                (control / (role + '.stop')).write_text('stop', encoding='ascii')
        for role, proc in processes.items():
            if role == 'host':
                continue
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=10)
                failed = True
                report['error'] = f'{role} 未能正常退出；请检查日志。'
        if 'host' in processes:
            (control / 'host.stop').write_text('stop', encoding='ascii')
            try:
                processes['host'].wait(timeout=40)
            except subprocess.TimeoutExpired:
                failed = True
                report['error'] = '网络仍在保存，未强制结束；请查看 host.log。'
        for log in logs.values():
            log.close()
        report['status'] = 'error' if failed else 'stopped'
        atomic_json(state_file, report)
        print(report['status'].upper(), flush=True)
    return int(failed)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--mode', choices=MODES, default='classroom')
    parser.add_argument('--session', default='rec01')
    parser.add_argument('--network', default='http://127.0.0.1:18600')
    parser.add_argument('--worker')
    parser.add_argument('--stop-file', type=Path)
    args = parser.parse_args()
    args.root = args.root.resolve()
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,24}', args.session):
        parser.error('Invalid session')
    if args.mode != 'join':
        args.network = 'http://127.0.0.1:18600'
    if args.worker:
        worker(args)
        return 0
    return supervise(args)


if __name__ == '__main__':
    sys.exit(main())
