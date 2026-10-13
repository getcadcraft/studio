<?php
// SPDX-License-Identifier: Apache-2.0
/**
 * catalog.php — the lineup facts the hub shows, from the site's Catalog (the only source of app names, roles and
 * colours; the site notes). Prints JSON: {apps: [{slug, name, layer, role, short}], upcoming: [{slug, name, short}]}.
 * No familiar_to / familiar_line: other companies' product names never appear in the hub.
 *   sudo -u www-data env CADCRAFT_SITE=<site> php catalog.php
 */

declare(strict_types=1);

$site = getenv('CADCRAFT_SITE') ?: '';
if ($site === '') { fwrite(STDERR, basename(__FILE__) . ": CADCRAFT_SITE is not set: point it at the site's folder\n"); exit(1); }
require_once $site . '/public_html/core/bootstrap.php';

$pick = static fn(array $a, array $k) => array_intersect_key($a, array_flip($k));
echo json_encode([
    'apps' => array_map(static fn($a) => $pick($a, ['slug', 'name', 'layer', 'role', 'short']), Catalog::apps()),
    'upcoming' => array_map(static fn($a) => $pick($a, ['slug', 'name', 'short']), Catalog::upcoming()),
], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), "\n";
