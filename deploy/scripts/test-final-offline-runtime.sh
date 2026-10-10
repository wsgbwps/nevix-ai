#!/usr/bin/env bash
# Exact production bytes only. No builds, signatures, registry access or host Docker daemon.
set -euo pipefail
runtime() {
python3 - "$@" <<'PY'
import base64, hashlib, http.client, json, os, pathlib, re, secrets, ssl, subprocess, sys, tarfile, tempfile

def metadata(bundle, envelope, version, source):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version) or not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('invalid release identity')
    outer = json.loads(pathlib.Path(envelope).read_bytes())
    manifest = json.loads(base64.b64decode(outer['payload'], validate=True))
    digest = hashlib.sha512()
    with open(bundle, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
    if (manifest['version'], manifest['platform'], manifest['arch']) != (version, 'linux', 'amd64'):
        raise ValueError('release identity mismatch')
    if manifest['size'] != os.stat(bundle).st_size or manifest['sha512'] != base64.b64encode(digest.digest()).decode():
        raise ValueError('release bytes mismatch')
    # Only called on real inputs after the official compiled-anchor verifier succeeds.
    with tarfile.open(bundle, 'r:gz') as archive:
        entries = [x for x in archive.getmembers() if x.name == 'bundle.json']
        if len(entries) != 1 or not entries[0].isfile() or entries[0].size > 1024 * 1024:
            raise ValueError('invalid inventory')
        inventory = json.load(archive.extractfile(entries[0]))
    if inventory['source_commit'] != source or inventory['version'] != version:
        raise ValueError('source identity mismatch')
    return dict(version=version, source_commit=source, sha512=manifest['sha512'], size=manifest['size'])

# Extra material makes the genuine secrets snapshot refuse both absent-key and
# configured-key volumes. Never fabricate, chmod or replace a credential key.
refusal_marker = '.nevix-349-snapshot-refusal'
refusal_create = 'test -d "$1"; cd "$1"; (set -C; umask 077; : > '+refusal_marker+')'

def selfcheck():
    import io
    with tempfile.TemporaryDirectory() as root:
        bundle, envelope = root+'/bundle.tar.gz', root+'/release.json'
        inventory = json.dumps(dict(source_commit='a'*40, version='1.0.1')).encode()
        with tarfile.open(bundle, 'w:gz') as archive:
            entry=tarfile.TarInfo('bundle.json'); entry.size=len(inventory); archive.addfile(entry, io.BytesIO(inventory))
        data=pathlib.Path(bundle).read_bytes()
        payload=dict(version='1.0.1', platform='linux', arch='amd64', size=len(data), sha512=base64.b64encode(hashlib.sha512(data).digest()).decode())
        pathlib.Path(envelope).write_text(json.dumps(dict(payload=base64.b64encode(json.dumps(payload).encode()).decode())))
        assert metadata(bundle,envelope,'1.0.1','a'*40)['version']=='1.0.1'
        for version, source in [('1.0.0','a'*40),('1.0.1','b'*40),('1.0.1','bad')]:
            try: metadata(bundle,envelope,version,source)
            except ValueError: pass
            else: raise AssertionError('identity mismatch accepted')
        pathlib.Path(bundle).write_bytes(data+b'x')
        try: metadata(bundle,envelope,'1.0.1','a'*40)
        except ValueError: pass
        else: raise AssertionError('changed bytes accepted')
    with tempfile.TemporaryDirectory() as directory:
        volume = pathlib.Path(directory)
        marker = volume/refusal_marker
        # Exercise exactly the injector used in the real container, without Docker.
        subprocess.run(['sh','-ec',refusal_create,'sh',directory],check=True)
        assert marker.is_file() and marker.stat().st_mode & 0o777 == 0o600
        assert not (volume/'provider-credential-master.key').exists()
        marker.write_bytes(b'preexisting owned fixture bytes')
        result = subprocess.run(['sh','-ec',refusal_create,'sh',directory],stderr=subprocess.DEVNULL)
        assert result.returncode != 0 and marker.read_bytes() == b'preexisting owned fixture bytes'
        marker.unlink()
        key = volume/'provider-credential-master.key'
        material = bytes(range(32)); key.write_bytes(material); key.chmod(0o600)
        subprocess.run(['sh','-ec',refusal_create,'sh',directory],check=True)
        marker.unlink()
        assert key.read_bytes() == material and key.stat().st_mode & 0o777 == 0o600
    print('metadata and exclusive refusal-marker preservation self-checks passed; no signature/runtime acceptance claimed')

if sys.argv[1:] == ['--self-check']:
    selfcheck(); sys.exit(0)
mode, cli, cli_sha, old_bundle, old_manifest, old_version, old_source, new_bundle, new_manifest, new_version, new_source, receipt_path = sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{64}', cli_sha) or hashlib.sha256(pathlib.Path(cli).read_bytes()).hexdigest() != cli_sha:
    raise SystemExit('independently trusted CLI SHA256 mismatch')
if tuple(map(int,new_version.split('.'))) <= tuple(map(int,old_version.split('.'))):
    raise SystemExit('candidate must be newer than source')
if pathlib.Path(receipt_path).exists(): raise SystemExit('receipt must not exist')
# This seam never accepts a caller-provided public key, never uses the candidate bundled tool.
for bundle, envelope in [(old_bundle,old_manifest),(new_bundle,new_manifest)]:
    verified=subprocess.run([cli,'verify','--manifest',envelope,'--bundle',bundle], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if verified.returncode: raise SystemExit('production signature/archive verification failed')
old=metadata(old_bundle,old_manifest,old_version,old_source)
new=metadata(new_bundle,new_manifest,new_version,new_source)
if mode == '--verify': sys.exit(0)
if mode != '--inside' or os.uname().sysname != 'Linux' or os.uname().machine != 'x86_64' or os.environ.get('DOCKER_HOST') != 'unix://'+str(pathlib.Path(cli).parent/'docker.sock') or os.environ.get('DOCKER_CONTEXT'):
    raise SystemExit('isolated daemon context required')
root=pathlib.Path(cli).parent
instance=root/'instance'; instance.mkdir(mode=0o700)
private=root/'private'; private.mkdir(mode=0o700)
receipt=dict(format='nevix-final-offline-acceptance-v1',status='failed',platform='native-linux-amd64',cli_sha256=cli_sha,old=old,new=new,completed=[],missing_cases=['queued-task drain timeout/fencing','candidate migration failure','candidate health failure','Desktop/Server version-window refusal','encrypted provider/object-storage credential retention'],storage=os.environ['NEVIX_DEPLOY_TEST_STORE'])
step='start'
def command(args, allowed_failure=False):
    with open(private/'commands.log','ab') as log:
        result=subprocess.run(args,stdout=subprocess.PIPE,stderr=log,timeout=900)
        log.write(result.stdout)
    if result.returncode and not allowed_failure: raise RuntimeError('command failed')
    return result

def compose(version,*args):
    return command(['docker','compose','--project-name','nevix','--env-file',str(instance/'.env'),'-f',str(instance/'releases'/version/'compose.yaml'),*args]).stdout

def mark(name): receipt['completed'].append(name)

try:
    step='isolated empty image cache'
    if command(['docker','image','ls','--quiet']).stdout.strip(): raise RuntimeError('cache not empty')
    if command(['docker','info','--format','{{.Architecture}}']).stdout.strip() not in (b'x86_64',b'amd64'): raise RuntimeError('daemon not native amd64')
    mark(step)
    step='official import/install old final bundle'
    command([cli,'import','--manifest',old_manifest,'--bundle',old_bundle,'--directory',str(instance)])
    env=('NEVIX_PUBLIC_IP=127.0.0.1\nPOSTGRES_PASSWORD='+secrets.token_hex(24)+'\nNEVIX_IDENTITY_APP_PASSWORD='+secrets.token_hex(24)+'\nNEVIX_SETUP_CODE_REQUIRED=false\nCORS_ALLOWED_ORIGINS=null\nCERT_FORCE_NEW=false\n').encode()
    (instance/'.env').write_bytes(env); os.chmod(instance/'.env',0o600)
    command([cli,'install','--manifest',old_manifest,'--bundle',old_bundle,'--directory',str(instance)])
    mark(step)
    cert=compose(old_version,'exec','-T','cert-watch','cat','/etc/nginx/tls/server.pem').decode()
    fingerprint=hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert)).hexdigest()
    tls=ssl.create_default_context(cadata=cert)
    token=''; credentials=dict(email='final349@example.com',password=secrets.token_urlsafe(32)+'Aa1!')
    def request(method,path,body=None,expected_status=200):
        client=http.client.HTTPSConnection('127.0.0.1',443,context=tls,timeout=20)
        try:
            client.request(method,path,body=None if body is None else json.dumps(body),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
            response=client.getresponse(); data=response.read()
            if response.status != expected_status: raise RuntimeError('public API failed')
            return json.loads(data)
        finally: client.close()
    step='real public claim/Admin login'
    setup=request('GET','/identity/setup/status')
    if setup['initialized'] or setup['setup_code_required']: raise RuntimeError('fresh public-claim fixture unavailable')
    claim=request('POST','/identity/setup/initialize',credentials,expected_status=201)
    if claim['user']['role'] != 'admin' or not claim['token']: raise RuntimeError('claim failed')
    token=claim['token']; identity=claim['user']['id']
    (private/'token').write_text(token); os.chmod(private/'token',0o600)
    (private/'credentials.json').write_text(json.dumps(credentials)); os.chmod(private/'credentials.json',0o600)
    mark(step)
    step='persistent TLS/config/Admin across restart'
    compose(old_version,'restart','server','nginx')
    compose(old_version,'up','--detach','--no-build','--pull','never','--wait','--wait-timeout','180')
    if compose(old_version,'exec','-T','cert-watch','cat','/etc/nginx/tls/server.pem').decode()!=cert: raise RuntimeError('TLS changed')
    login=request('POST','/identity/auth/login',credentials)
    if login['user']['id']!=identity or login['user']['role']!='admin': raise RuntimeError('Admin changed')
    token=login['token']; (private/'token').write_text(token)
    mark(step)
    postgres_id=compose(old_version,'ps','--quiet','postgres').strip()
    server_id=compose(old_version,'ps','--quiet','server').strip()
    if not postgres_id or not server_id: raise RuntimeError('running containers absent')
    upgrade=[cli,'upgrade','--directory',str(instance),'--server-url','https://127.0.0.1','--tls-fingerprint',fingerprint,'--token-file',str(private/'token'),'--bundle',new_bundle,'--manifest',new_manifest,'--original-bundle',old_bundle,'--original-manifest',old_manifest,'--drain-timeout','30s']
    step='backup failure before replacement resumes old Server'
    secrets_directory='/var/lib/nevix/secrets'
    original_secrets=compose(old_version,'exec','-T','--user','root','server','ls','-A',secrets_directory)
    injected=False
    try:
        compose(old_version,'exec','-T','--user','root','server','sh','-ec',refusal_create,'sh',secrets_directory)
        injected=True
        failed=command(upgrade+['--backup',str(private/'refused.tar.gz')],allowed_failure=True)
        if failed.returncode==0 or b'secrets private volume snapshot command failed' not in failed.stdout+(private/'commands.log').read_bytes(): raise RuntimeError('expected backup failure absent')
        if request('GET','/creation/maintenance')['paused'] or request('GET','/release/version')['version']!=old_version: raise RuntimeError('old runtime not resumed')
    finally:
        if injected:
            compose(old_version,'exec','-T','--user','root','server','rm','--',secrets_directory+'/'+refusal_marker)
    if compose(old_version,'exec','-T','--user','root','server','ls','-A',secrets_directory)!=original_secrets: raise RuntimeError('refusal fixture changed original secrets inventory')
    mark(step)
    step='official final upgrade/drain/backup/rehearsal/health gate'
    backup=private/'upgrade.tar.gz'
    command(upgrade+['--backup',str(backup)])
    if not backup.is_file() or backup.stat().st_size==0 or (instance/'current').read_text().strip()!=new_version: raise RuntimeError('upgrade evidence missing')
    mark(step)
    step='retained Admin/session/config/TLS/volumes and resumed admission'
    if request('GET','/release/version')['version']!=new_version or request('GET','/creation/maintenance')['paused']: raise RuntimeError('new runtime not resumed')
    login=request('POST','/identity/auth/login',credentials)
    if login['user']['id']!=identity or login['user']['role']!='admin' or (instance/'.env').read_bytes()!=env: raise RuntimeError('state changed')
    if compose(new_version,'exec','-T','cert-watch','cat','/etc/nginx/tls/server.pem').decode()!=cert: raise RuntimeError('TLS changed')
    if compose(new_version,'exec','-T','--user','root','server','ls','-A',secrets_directory)!=original_secrets: raise RuntimeError('secrets inventory changed during upgrade')
    for volume in ('nevix_pgdata','nevix_tls','nevix_secrets'): command(['docker','volume','inspect',volume])
    if compose(new_version,'ps','--quiet','postgres').strip()!=postgres_id or compose(new_version,'ps','--quiet','server').strip()==server_id: raise RuntimeError('Server-first container retention failed')
    mark(step)
    receipt['state_retention'] = dict(admin_identity=True, original_session=True, customer_config=True, tls=True, persistent_volumes=True, original_postgres_container=True, server_replaced=True, admission_resumed=True, secrets_inventory=True)
    receipt['status']='passed-covered-cases'
except Exception:
    receipt['failed_step']=step
finally:
    # Only explicit identities and assertion labels leave the private fixture.
    with open(receipt_path,'x') as stream: json.dump(receipt,stream,indent=2); stream.write('\n')
if receipt['status']!='passed-covered-cases': raise SystemExit('final offline acceptance failed at '+step+'; sanitized receipt written')
print('final offline covered cases passed; missing cases remain in receipt')
PY
}
if [[ ${1:-} == --inside ]]; then runtime "$@"; exit; fi
if [[ ${1:-} == --self-check ]]; then runtime --self-check; exit; fi
if [[ $# != 11 ]]; then
  echo 'usage: test-final-offline-runtime.sh TRUSTED_CLI CLI_SHA256 OLD_BUNDLE OLD_ENVELOPE OLD_VERSION OLD_SOURCE_SHA NEW_BUNDLE NEW_ENVELOPE NEW_VERSION NEW_SOURCE_SHA NEW_RECEIPT.json' >&2
  exit 1
fi
if [[ $(uname -s) != Linux || $(uname -m) != x86_64 ]]; then
  echo 'Requires native Linux x86_64. No emulation or runtime acceptance performed.' >&2; exit 1
fi
for dependency in python3 docker dockerd containerd sudo unshare nsenter setpriv ip realpath; do command -v "$dependency" >/dev/null; done
sudo -n true
store=${NEVIX_DEPLOY_TEST_STORE:-containerd}
if [[ $store != classic && $store != containerd ]]; then echo 'store must be classic or containerd' >&2; exit 1; fi
umask 077
script=$(realpath "$0")
receipt=$(realpath -m "${11}")
[[ ! -e $receipt && -d $(dirname "$receipt") ]] || { echo 'new receipt in existing directory required' >&2; exit 1; }
scratch=$(mktemp -d)
cleanup() {
  if [[ -S $scratch/docker.sock ]]; then
    containers=$(env -u DOCKER_CONTEXT DOCKER_HOST="unix://$scratch/docker.sock" docker ps --all --quiet 2>/dev/null || true)
    if [[ -n $containers ]]; then env -u DOCKER_CONTEXT DOCKER_HOST="unix://$scratch/docker.sock" docker rm --force $containers >/dev/null 2>&1 || true; fi
  fi
  if [[ -f $scratch/docker.pid ]]; then sudo -n kill "$(cat "$scratch/docker.pid")" 2>/dev/null || true; fi
  if [[ -n ${daemon_pid:-} ]]; then wait "$daemon_pid" 2>/dev/null || true; fi
  if [[ -f $scratch/containerd.pid ]]; then
    private_containerd_pid=$(cat "$scratch/containerd.pid")
    sudo -n kill "$private_containerd_pid" 2>/dev/null || true
    for attempt in $(seq 1 60); do sudo -n kill -0 "$private_containerd_pid" 2>/dev/null || break; sleep 0.1; done
  fi
  sudo -n rm -rf "$scratch"
}
trap cleanup EXIT
# Freeze verifier and artifacts before authentication, imports and receipt hashing.
cp --reflink=auto "$1" "$scratch/nevix-deploy"
cp --reflink=auto "$3" "$scratch/old.tar.gz"
cp "$4" "$scratch/old.json"
cp --reflink=auto "$7" "$scratch/new.tar.gz"
cp "$8" "$scratch/new.json"
chmod 0700 "$scratch/nevix-deploy"
args=("$scratch/nevix-deploy" "$2" "$scratch/old.tar.gz" "$scratch/old.json" "$5" "$6" "$scratch/new.tar.gz" "$scratch/new.json" "$9" "${10}" "$receipt")
runtime --verify "${args[@]}"
printf '{}\n' > "$scratch/daemon.json"
feature=false; if [[ $store == containerd ]]; then feature=true; fi
sudo -n unshare --net bash -c '
  ip link set lo up
  scratch=$1; shift
  containerd --root "$scratch/containerd-root" --state "$scratch/containerd-state" --address "$scratch/containerd.sock" > "$scratch/containerd.log" 2>&1 &
  echo $! > "$scratch/containerd.pid"
  for attempt in $(seq 1 60); do [[ -S $scratch/containerd.sock ]] && break; sleep 1; done
  exec dockerd "$@"
' bash "$scratch" --config-file "$scratch/daemon.json" --host "unix://$scratch/docker.sock" --group "$(id -gn)" \
  --data-root "$scratch/data" --exec-root "$scratch/exec" --pidfile "$scratch/docker.pid" --bridge none --iptables=false --ip-masq=false \
  --containerd "$scratch/containerd.sock" --containerd-namespace nevix-runtime --containerd-plugins-namespace nevix-runtime-plugins \
  --feature "containerd-snapshotter=$feature" > "$scratch/daemon.log" 2>&1 &
daemon_pid=$!
unset DOCKER_CONTEXT
export DOCKER_HOST="unix://$scratch/docker.sock" DOCKER_CONFIG="$scratch/docker-client" NEVIX_DEPLOY_TEST_STORE="$store"
mkdir -m 0700 "$DOCKER_CONFIG"; printf '{}\n' > "$DOCKER_CONFIG/config.json"
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  kill -0 "$daemon_pid" 2>/dev/null || { echo 'isolated daemon failed (private logs withheld)' >&2; exit 1; }
  sleep 1
done
docker info >/dev/null
# HTTP CLI and probes share only the isolated daemon network namespace.
sudo -n --preserve-env=DOCKER_CONFIG,DOCKER_HOST,NEVIX_DEPLOY_TEST_STORE nsenter --net --target "$(cat "$scratch/docker.pid")" \
  setpriv --reuid "$(id -u)" --regid "$(id -g)" --init-groups bash "$script" --inside "${args[@]}"
