#!/bin/bash
# Set up a kind cluster with agent-sandbox CRDs installed.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-memflywheel-e2e}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v0.5.0}"

echo "==> Creating kind cluster: ${CLUSTER_NAME}"
kind create cluster --name "${CLUSTER_NAME}" --wait 120s

echo "==> Installing agent-sandbox ${AGENT_SANDBOX_VERSION} CRDs + controller"
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/manifest.yaml"
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/extensions.yaml"

echo "==> Waiting for agent-sandbox controller to be ready"
kubectl wait --for=condition=Ready pod -l app=agent-sandbox-controller \
  -n agent-sandbox-system --timeout=120s

echo "==> Creating test namespaces"
kubectl create namespace hermes-test --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace pi-test --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace openclaw-test --dry-run=client -o yaml | kubectl apply -f -

echo "==> Setup complete"
kubectl get pods -A
