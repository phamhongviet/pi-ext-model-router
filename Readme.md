# What It Is
A pi.dev extension that automatically selects a model using TypeSafe Jev.

## Installation

    cp model-router.ts ~/.pi/agent/extensions/

## Usage

    export TYPESAFE_API_KEY=apikey-...
    pi

## Configuration

Edit `MODELS` in `model-router.ts` to define the model list. Routing uses Jev's full probability distribution and cumulative escalation thresholds from `ESCALATION_THRESHOLDS`; calibrate those thresholds with your evals before relying on them in production.

## Test

    node --experimental-strip-types --test model-router.test.ts
