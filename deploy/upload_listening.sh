#!/usr/bin/env bash
set -euo pipefail

container="${1:-eng4sp-app-1}"
exam_period_id="${2:-}"
mp3_path="${3:-}"

if [[ -z "${exam_period_id}" || -z "${mp3_path}" ]]; then
  echo "Usage: $0 <container> <examPeriodId> </path/to/listening.mp3>" >&2
  echo "Example: $0 eng4sp-app-1 1 ./listening.mp3" >&2
  exit 2
fi

if ! [[ "${exam_period_id}" =~ ^[0-9]+$ ]] || [[ "${exam_period_id}" -le 0 ]]; then
  echo "Invalid examPeriodId: ${exam_period_id}" >&2
  exit 2
fi

if [[ ! -f "${mp3_path}" ]]; then
  echo "File not found: ${mp3_path}" >&2
  exit 2
fi

dest_dir="/app/storage/listening/ep_${exam_period_id}"
dest_path="${dest_dir}/listening.mp3"

echo "Uploading ${mp3_path} -> ${container}:${dest_path}"
docker exec -i "${container}" mkdir -p "${dest_dir}"
docker cp "${mp3_path}" "${container}:${dest_path}"
docker exec -i "${container}" ls -lh "${dest_path}"

echo "Done."
