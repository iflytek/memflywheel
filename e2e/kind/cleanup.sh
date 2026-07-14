#!/bin/bash
# Tear down the kind cluster.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-memflywheel-e2e}"
echo "==> Deleting kind cluster: ${CLUSTER_NAME}"
kind delete cluster --name "${CLUSTER_NAME}" || true
