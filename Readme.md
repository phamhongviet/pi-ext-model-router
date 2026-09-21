# What It Is
A pi.dev extension that automatically selects a model using TypeSafe Jev.

## Installation

    cp model-router.ts ~/.pi/agent/extensions/

## Usage

    export TYPESAFE_API_KEY=apikey-...
    pi

## Configuration

    Edit model-router.ts to define your model list.

## Routing eval

`routing_eval.jsonl` contains 120 evenly labeled DevOps prompts based on AWS and Kubernetes work, from quick explanations through repository-wide operations.

    python3 eval_router.py --check
    TYPESAFE_API_KEY=apikey-... python3 eval_router.py

Use `--limit 10` for a smoke run and `--output results.json` to retain per-case results. The report shows exact accuracy, under-routing, over-routing, a confusion matrix, and each mismatch.
