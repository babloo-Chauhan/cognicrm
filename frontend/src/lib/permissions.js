export function hasPermission(user, permission) {
  const granted = [...(user?.permissions || []), ...(user?.extraPermissions || [])];
  return granted.some((p) => p === '*' || p === permission || (p.endsWith(':*') && permission.startsWith(p.slice(0, -1))));
}
