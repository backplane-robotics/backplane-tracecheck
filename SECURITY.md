# Security policy

Tracecheck reads untrusted files (MCAP recordings and JSON contracts), so we treat parser bugs as security issues. Examples include crashes, unbounded memory or CPU use, decompression bombs that get past the limits, and anything in the web app that could send file contents off the device.

## Reporting a vulnerability

Please **do not open a public issue**. Instead, either:

- use GitHub's [private vulnerability reporting](https://github.com/backplane-robotics/backplane-tracecheck/security/advisories/new), or
- email **hello@backplanerobotics.com** with the subject line "Security".

If you can, include a minimal reproducing file. Synthetic files are ideal; please don't send real customer recordings. We aim to acknowledge reports within 3 business days.

## Supported versions

Only the latest release receives security fixes.
