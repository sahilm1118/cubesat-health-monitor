"""Rebuild every result on the website from the raw datasets.

  1. improve_models.py  - candidate models, selected by 5-fold CV on the training split
  2. pipeline_fd.py     - deployed fault detector, calibration, explanations, injection validation, FDIR simulation
  3. pipeline_batt.py   - battery fleet SOH / RUL with conformal intervals
  4. pipeline_esa.py    - cross-mission test on ESA-ADB Mission 1 (only if the dataset has been downloaded)

Run from the scripts folder:  python train_models.py   then   python build_site.py
"""
import runpy
from pathlib import Path

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    for step in ["improve_models.py", "pipeline_fd.py", "pipeline_batt.py", "pipeline_esa.py"]:
        if (HERE / step).exists():
            print(f"\n=== {step}")
            runpy.run_path(str(HERE / step), run_name="__main__")
