import { readEnv } from './env.mjs';
import { isSensitiveRepoPath, sensitivePolicyPaths } from './submission-policy.mjs';
import { assignmentNamedCheck, isNamedCheck, ownerCheck } from './projects.mjs';
import { parseHostBudget } from './host-budget.mjs';
import { hostCheckPairAllowed } from './host-check-allowlist.mjs';
import fs from 'node:fs';

export const RESOURCE_LIMITS_UNAVAILABLE='resource_limits_unavailable: host checks are disabled; an operator must set DALAN_HOST_CHECKS=1 and each check must declare host_budget';

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function hostCheckAuthorization(repo, checkId, expectedSpec = null, assignment = null) {
  const named=isNamedCheck(checkId)&&Array.isArray(assignment?.checks)&&assignment.checks.length>0;
  if (!hostCheckPairAllowed(repo, named?'named':checkId)) return { refusal: named?
    'host_check_not_allowlisted: allow (repo, named) to run requester-declared checks' :
    'host_check_not_allowlisted: owner allowlist does not permit this repository/check pair' };
  let spec;
  try { spec = ownerCheck(repo, named?'default':checkId); } catch { return { refusal: 'host_check_owner_definition_unavailable: owner check configuration is invalid or unavailable' }; }
  if (!spec) return { refusal: 'host_check_owner_definition_required: this check has no current owner-configured definition' };
  if (!spec.host_budget) return { refusal: 'host_budget_missing: declare host_budget in owner configuration' };
  try { parseHostBudget(spec.host_budget); } catch { return { refusal: 'host_budget_missing: declare a valid host_budget in owner configuration' }; }
  if (named) {
    const policy=sensitivePolicyPaths();
    if (policy.error) return { refusal: 'sensitive_policy_unavailable: restore a valid mode-0600 submission policy before running host checks' };
    spec=assignmentNamedCheck(assignment,checkId,spec);
    if (!spec || isSensitiveRepoPath(spec.test_paths[0],policy.paths) ||
        assignment.scope_excluded?.some(entry=>entry.path===spec.test_paths[0]))
      return { refusal: 'invalid_named_check: a current non-sensitive named check is required' };
  }
  if (expectedSpec && !same(spec, expectedSpec)) return { refusal: 'host_check_definition_changed: owner definition changed after resolution' };
  return { spec };
}

export function hostCheckRefusal(assignment={}, repo=null, checkId=null, expectedSpec=null,excludedPathsAbsent=false) {
  const scope=assignment.scope_paths;
  const narrow=Array.isArray(scope)&&scope.length&&!scope.some(p=>p.replace(/^\.\//,'').replace(/\/$/,'')==='.');
  if(narrow||(assignment.scope_excluded?.length&&!excludedPathsAbsent)) {
    return 'scope_paths_read_isolation_unavailable: this executor exposes the whole checkout; a check needs an owner-approved repository-wide read grant';
  }
  if(sensitivePolicyPaths().error) return 'sensitive_policy_unavailable: restore a valid mode-0600 submission policy before running host checks';
  if(readEnv('DALAN_HOST_CHECKS')!=='1') return RESOURCE_LIMITS_UNAVAILABLE;
  if(repo!==null&&checkId!==null) {
    const authorization=hostCheckAuthorization(repo,checkId,expectedSpec,assignment);
    if(authorization.refusal) return authorization.refusal;
  }
  if(process.platform!=='linux') return `resource_limits_unavailable: no enforced host budget backend on ${process.platform}`;
  if(!fs.existsSync('/usr/bin/systemd-run')||!fs.existsSync('/usr/bin/python3')||!fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return 'resource_limits_unavailable: Python 3.12+, systemd user services and unified cgroups are required';
  return null;
}
