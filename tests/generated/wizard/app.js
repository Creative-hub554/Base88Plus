document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab');
  const steps = document.querySelectorAll('.step');
  const nextBtn = document.getElementById('next');
  const backBtn = document.getElementById('back');
  const summary = document.querySelector('.summary');
  let currentStep = 1;
  const formValues = {};

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const step = parseInt(tab.getAttribute('data-step'));
      if (step === currentStep || step > steps.length || step < 1) return;
      steps.forEach(s => s.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      steps[step - 1].classList.add('active');
      currentStep = step;
    });
  });

  nextBtn.addEventListener('click', e => {
    e.preventDefault();
    if (currentStep >= steps.length) {
      // Capture the LAST step's values before rendering - the other steps
      // were captured when Next left them, but nothing leaves step N.
      const lastForm = document.querySelector(`#step${currentStep}`);
      if (lastForm.checkValidity()) {
        formValues[lastForm.id] = { ...formValues[lastForm.id], ...Object.fromEntries(new FormData(lastForm)) };
      }
      renderSummary();
      return;
    }
    const currentForm = document.querySelector(`#step${currentStep}`);
    if (currentForm.checkValidity()) {
      formValues[currentForm.id] = { ...formValues[currentForm.id], ...Object.fromEntries(new FormData(currentForm)) };
      currentForm.classList.add('complete');
      steps[currentStep - 1].classList.add('hidden');
      steps[currentStep].classList.remove('hidden');
      currentStep++;
    }
  });

  backBtn.addEventListener('click', e => {
    e.preventDefault();
    if (currentStep === 1) return;
    currentStep--;
    steps.forEach(s => s.classList.add('hidden'));
    steps[currentStep].classList.remove('hidden');
    tabs.forEach(t => t.classList.remove('active'));
    tabs[currentStep - 1].classList.add('active');
  });

  function renderSummary() {
    summary.innerHTML = '';
    for (const [formId, values] of Object.entries(formValues)) {
      if (!values) continue;
      for (const [label, value] of Object.entries(values)) {
        const div = document.createElement('div');
        div.textContent = `${label}: ${value}`;
        summary.appendChild(div);
      }
    }
  }
});